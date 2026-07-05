import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../config/prisma';
import { RequestStatus } from '../../generated/hermes';

// Pass A (the add pass) is exactly today's importRedashMemberships — it needs
// live Redash + live Keycloak, which the test environment doesn't have. Stub it
// out so these tests exercise Pass B (remove orphaned grants) and Pass C (fix
// stuck requests) directly against DB state + a manually-seeded platform cache,
// per the plan's "design so the new passes are testable without live mode".
vi.mock('./redash-import.service', () => ({
  importRedashMemberships: vi.fn(async (opts: { apply: boolean }) => ({
    apply: opts.apply,
    mappedGroups: 0,
    cachedUsers: 0,
    usersMatched: 0,
    usersSkippedNoKeycloak: [],
    usersSkippedDisabled: [],
    accountRequestsCreated: 0,
    grantsCreated: 0,
    grantsAlreadyPresent: 0,
    membershipsUnmapped: [],
    levelConflicts: [],
  })),
}));

import { resyncRedashMemberships } from './redash-resync.service';
import provisioningRegistry from './provisioning.registry';

describe('redash-resync.service', () => {
  const performer = { performerId: 'usr-admin', performerName: 'admin.user' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Pass B — remove orphaned grants', () => {
    it('deactivates a grant whose user is no longer in the backing Redash group (dry run first, then apply)', async () => {
      const group = await prisma.group.create({
        data: {
          name: 'Growth',
          slug: 'growth',
          description: 'Growth data',
          platform: 'redash',
          externalGroupId: 'ext-growth',
        },
      });

      // Cache reflects live Redash: user is NOT in ext-growth anymore.
      await prisma.platformExternalUser.create({
        data: {
          platform: 'redash',
          externalId: 'ext-user-1',
          email: 'orphan@bachatt.app',
          name: 'Orphan User',
          externalGroupIds: [], // removed from the group directly in Redash
          lastSyncedAt: new Date(),
        },
      });

      const access = await prisma.userAccess.create({
        data: {
          userId: 'usr-orphan',
          userName: 'Orphan User',
          userEmail: 'orphan@bachatt.app',
          groupId: group.id,
          externalUserId: 'ext-user-1',
          isActive: true,
          grantedBy: 'admin.user',
        },
      });

      // Dry run: nothing written.
      const dryRun = await resyncRedashMemberships({ platform: 'redash', apply: false, ...performer });
      expect(dryRun.grantsDeactivated).toBe(1);
      expect(dryRun.deactivatedGrants).toEqual(['orphan@bachatt.app → Growth (no longer on Redash)']);
      const stillActive = await prisma.userAccess.findUnique({ where: { id: access.id } });
      expect(stillActive?.isActive).toBe(true);

      // Apply: grant deactivated, no platform call needed (already gone), audited.
      const applied = await resyncRedashMemberships({ platform: 'redash', apply: true, ...performer });
      expect(applied.grantsDeactivated).toBe(1);
      const deactivated = await prisma.userAccess.findUnique({ where: { id: access.id } });
      expect(deactivated?.isActive).toBe(false);
      expect(deactivated?.revokedAt).not.toBeNull();

      const audit = await prisma.auditEntry.findFirst({ where: { action: 'ACCESS_REVOKED', targetUserId: 'usr-orphan' } });
      expect(audit).not.toBeNull();
      expect((audit?.details as any)?.source).toBe('redash-resync');
    });

    it('leaves a grant alone when the user is still in the backing Redash group', async () => {
      const group = await prisma.group.create({
        data: { name: 'Growth', slug: 'growth', description: 'd', platform: 'redash', externalGroupId: 'ext-growth' },
      });
      await prisma.platformExternalUser.create({
        data: {
          platform: 'redash',
          externalId: 'ext-user-2',
          email: 'present@bachatt.app',
          name: 'Present User',
          externalGroupIds: ['ext-growth'],
          lastSyncedAt: new Date(),
        },
      });
      const access = await prisma.userAccess.create({
        data: {
          userId: 'usr-present',
          userName: 'Present User',
          userEmail: 'present@bachatt.app',
          groupId: group.id,
          externalUserId: 'ext-user-2',
          isActive: true,
          grantedBy: 'admin.user',
        },
      });

      const applied = await resyncRedashMemberships({ platform: 'redash', apply: true, ...performer });
      expect(applied.grantsDeactivated).toBe(0);
      const stillActive = await prisma.userAccess.findUnique({ where: { id: access.id } });
      expect(stillActive?.isActive).toBe(true);
    });

    it('skips the remove pass entirely when the refreshed platform cache is empty (safety guard)', async () => {
      const group = await prisma.group.create({
        data: { name: 'Growth', slug: 'growth', description: 'd', platform: 'redash', externalGroupId: 'ext-growth' },
      });
      // No platformExternalUser rows at all — cache came back empty.
      const access = await prisma.userAccess.create({
        data: {
          userId: 'usr-x',
          userName: 'X',
          userEmail: 'x@bachatt.app',
          groupId: group.id,
          externalUserId: 'ext-user-x',
          isActive: true,
          grantedBy: 'admin.user',
        },
      });

      const applied = await resyncRedashMemberships({ platform: 'redash', apply: true, ...performer });
      expect(applied.removePassSkippedEmptyCache).toBe(true);
      expect(applied.grantsDeactivated).toBe(0);
      const stillActive = await prisma.userAccess.findUnique({ where: { id: access.id } });
      expect(stillActive?.isActive).toBe(true);
    });

    it('skips (and reports) an active grant on a group with no resolvable externalGroupId', async () => {
      const group = await prisma.group.create({
        data: { name: 'Unmapped', slug: 'unmapped', description: 'd', platform: 'redash', externalGroupId: null },
      });
      await prisma.platformExternalUser.create({
        data: {
          platform: 'redash',
          externalId: 'ext-user-3',
          email: 'unmapped@bachatt.app',
          name: 'Unmapped User',
          externalGroupIds: [],
          lastSyncedAt: new Date(),
        },
      });
      const access = await prisma.userAccess.create({
        data: {
          userId: 'usr-unmapped',
          userName: 'Unmapped User',
          userEmail: 'unmapped@bachatt.app',
          groupId: group.id,
          externalUserId: 'ext-user-3',
          isActive: true,
          grantedBy: 'admin.user',
        },
      });

      const applied = await resyncRedashMemberships({ platform: 'redash', apply: true, ...performer });
      expect(applied.grantsDeactivated).toBe(0);
      expect(applied.activeGrantsSkippedUnmapped).toEqual(['unmapped@bachatt.app → Unmapped']);
      const stillActive = await prisma.userAccess.findUnique({ where: { id: access.id } });
      expect(stillActive?.isActive).toBe(true);
    });
  });

  describe('Pass B — disabled Redash account', () => {
    it('leaves a grant intact when the account is disabled but still a group member (offboarding keeps it; re-enable restores access)', async () => {
      const group = await prisma.group.create({
        data: { name: 'Growth', slug: 'growth', description: 'd', platform: 'redash', externalGroupId: 'ext-growth' },
      });
      // Still listed as a member of the group, but the account is disabled — a
      // reversible offboarding-disable. Redash keeps the membership, so the grant
      // must survive (re-enabling the account restores access). Deactivating on
      // `isDisabled` here would silently break offboarding's "grants untouched" promise.
      await prisma.platformExternalUser.create({
        data: {
          platform: 'redash',
          externalId: 'ext-user-disabled',
          email: 'disabled@bachatt.app',
          name: 'Disabled User',
          isDisabled: true,
          externalGroupIds: ['ext-growth'],
          lastSyncedAt: new Date(),
        },
      });
      const access = await prisma.userAccess.create({
        data: {
          userId: 'usr-disabled',
          userName: 'Disabled User',
          userEmail: 'disabled@bachatt.app',
          groupId: group.id,
          externalUserId: 'ext-user-disabled',
          isActive: true,
          grantedBy: 'admin.user',
        },
      });

      const applied = await resyncRedashMemberships({ platform: 'redash', apply: true, ...performer });
      expect(applied.grantsDeactivated).toBe(0);

      const updated = await prisma.userAccess.findUnique({ where: { id: access.id } });
      expect(updated?.isActive).toBe(true);
    });

    it('still deactivates a disabled account that is ALSO no longer a group member (membership is the signal)', async () => {
      const group = await prisma.group.create({
        data: { name: 'Growth', slug: 'growth', description: 'd', platform: 'redash', externalGroupId: 'ext-growth' },
      });
      // Disabled AND removed from the group → genuinely gone, so the grant is deactivated.
      await prisma.platformExternalUser.create({
        data: {
          platform: 'redash',
          externalId: 'ext-user-gone',
          email: 'gone@bachatt.app',
          name: 'Gone User',
          isDisabled: true,
          externalGroupIds: [],
          lastSyncedAt: new Date(),
        },
      });
      const access = await prisma.userAccess.create({
        data: {
          userId: 'usr-gone',
          userName: 'Gone User',
          userEmail: 'gone@bachatt.app',
          groupId: group.id,
          externalUserId: 'ext-user-gone',
          isActive: true,
          grantedBy: 'admin.user',
        },
      });

      const applied = await resyncRedashMemberships({ platform: 'redash', apply: true, ...performer });
      expect(applied.grantsDeactivated).toBe(1);

      const updated = await prisma.userAccess.findUnique({ where: { id: access.id } });
      expect(updated?.isActive).toBe(false);
    });
  });

  describe('Pass B — health check gate', () => {
    it('skips the remove pass entirely when the platform health check reports unhealthy', async () => {
      const adapter = provisioningRegistry.get('redash');
      const originalHealthCheck = adapter.healthCheck.bind(adapter);
      (adapter as any).healthCheck = async () => ({ healthy: false, message: 'simulated outage' });

      try {
        const group = await prisma.group.create({
          data: { name: 'Growth', slug: 'growth', description: 'd', platform: 'redash', externalGroupId: 'ext-growth' },
        });
        // Would be a clear orphan if the health check weren't gating this off.
        await prisma.platformExternalUser.create({
          data: {
            platform: 'redash',
            externalId: 'ext-user-health',
            email: 'health@bachatt.app',
            name: 'Health User',
            externalGroupIds: [],
            lastSyncedAt: new Date(),
          },
        });
        const access = await prisma.userAccess.create({
          data: {
            userId: 'usr-health',
            userName: 'Health User',
            userEmail: 'health@bachatt.app',
            groupId: group.id,
            externalUserId: 'ext-user-health',
            isActive: true,
            grantedBy: 'admin.user',
          },
        });

        const applied = await resyncRedashMemberships({ platform: 'redash', apply: true, ...performer });
        expect(applied.removePassSkippedUnhealthy).toBe(true);
        expect(applied.removePassUnhealthyMessage).toBe('simulated outage');
        expect(applied.grantsDeactivated).toBe(0);

        const stillActive = await prisma.userAccess.findUnique({ where: { id: access.id } });
        expect(stillActive?.isActive).toBe(true);
      } finally {
        (adapter as any).healthCheck = originalHealthCheck;
      }
    });
  });

  describe('Pass B — level swap (user moved level directly on Redash)', () => {
    it('swaps a grant to the new level instead of leaving the user with zero access', async () => {
      const group = await prisma.group.create({
        data: { name: 'Credit Card', slug: 'credit-card', description: 'd', platform: 'redash', externalGroupId: null },
      });
      const junior = await prisma.groupLevel.create({
        data: { groupId: group.id, name: 'Junior', slug: 'junior', externalGroupId: 'ext-junior', rank: 1 },
      });
      const senior = await prisma.groupLevel.create({
        data: { groupId: group.id, name: 'Senior', slug: 'senior', externalGroupId: 'ext-senior', rank: 2 },
      });

      // Cache says the user is now in Senior's group, not Junior's anymore.
      await prisma.platformExternalUser.create({
        data: {
          platform: 'redash',
          externalId: 'ext-user-swap',
          email: 'moved@bachatt.app',
          name: 'Moved User',
          externalGroupIds: ['ext-senior'],
          lastSyncedAt: new Date(),
        },
      });

      const oldGrant = await prisma.userAccess.create({
        data: {
          userId: 'usr-swap',
          userName: 'Moved User',
          userEmail: 'moved@bachatt.app',
          groupId: group.id,
          levelId: junior.id,
          externalUserId: 'ext-user-swap',
          isActive: true,
          expiresAt: new Date('2027-01-01T00:00:00Z'), // temp grant — must survive the swap
          grantedBy: 'admin.user',
        },
      });

      const dryRun = await resyncRedashMemberships({ platform: 'redash', apply: false, ...performer });
      expect(dryRun.levelsSwapped).toBe(1);
      expect(dryRun.grantsDeactivated).toBe(0); // not counted as a plain removal
      expect(dryRun.swappedGrants[0]).toContain('Junior → Senior');

      const applied = await resyncRedashMemberships({ platform: 'redash', apply: true, ...performer });
      expect(applied.levelsSwapped).toBe(1);
      expect(applied.grantsDeactivated).toBe(0);

      const oldRow = await prisma.userAccess.findUnique({ where: { id: oldGrant.id } });
      expect(oldRow?.isActive).toBe(false);

      const newGrant = await prisma.userAccess.findFirst({
        where: { userId: 'usr-swap', groupId: group.id, isActive: true },
      });
      expect(newGrant?.levelId).toBe(senior.id);
      expect(newGrant?.externalUserId).toBe('ext-user-swap');
      expect(newGrant?.expiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z'); // carried over, not made permanent

      const audit = await prisma.auditEntry.findFirst({ where: { action: 'ACCESS_LEVEL_CHANGED', targetUserId: 'usr-swap' } });
      expect(audit).not.toBeNull();
      expect((audit?.details as any)?.toLevelName).toBe('Senior');
    });
  });

  describe('Pass B — stale externalUserId repair (user deleted + recreated on Redash)', () => {
    it('refreshes the grant onto the new external id instead of treating the membership as gone', async () => {
      const group = await prisma.group.create({
        data: { name: 'Growth', slug: 'growth', description: 'd', platform: 'redash', externalGroupId: 'ext-growth' },
      });

      // Cache was retargeted (by RedashProvisioner.syncUsers's own P2002 fix) onto
      // the recreated user's NEW external id — same email, still in the group.
      await prisma.platformExternalUser.create({
        data: {
          platform: 'redash',
          externalId: 'ext-user-new',
          email: 'recreated@bachatt.app',
          name: 'Recreated User',
          externalGroupIds: ['ext-growth'],
          lastSyncedAt: new Date(),
        },
      });

      // The grant still points at the OLD (now-orphaned) external id.
      const access = await prisma.userAccess.create({
        data: {
          userId: 'usr-recreated',
          userName: 'Recreated User',
          userEmail: 'recreated@bachatt.app',
          groupId: group.id,
          externalUserId: 'ext-user-old',
          isActive: true,
          grantedBy: 'admin.user',
        },
      });

      const dryRun = await resyncRedashMemberships({ platform: 'redash', apply: false, ...performer });
      expect(dryRun.externalUserIdsRefreshed).toBe(1);
      expect(dryRun.grantsDeactivated).toBe(0); // must NOT be treated as orphaned

      const applied = await resyncRedashMemberships({ platform: 'redash', apply: true, ...performer });
      expect(applied.externalUserIdsRefreshed).toBe(1);
      expect(applied.grantsDeactivated).toBe(0);

      const updated = await prisma.userAccess.findUnique({ where: { id: access.id } });
      expect(updated?.isActive).toBe(true);
      expect(updated?.externalUserId).toBe('ext-user-new');
    });
  });

  describe('Pass B — safety cap on removals', () => {
    it('blocks the remove pass on Apply when orphans exceed the cap, and force overrides it', async () => {
      const group = await prisma.group.create({
        data: { name: 'Growth', slug: 'growth', description: 'd', platform: 'redash', externalGroupId: 'ext-growth' },
      });

      // 10 active grants, all orphaned (cache is non-empty but none of them are
      // members) — well over max(5, 20% of 10) = 5.
      const accessIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const a = await prisma.userAccess.create({
          data: {
            userId: `usr-cap-${i}`,
            userName: `User ${i}`,
            userEmail: `cap${i}@bachatt.app`,
            groupId: group.id,
            externalUserId: `ext-cap-${i}`,
            isActive: true,
            grantedBy: 'admin.user',
          },
        });
        accessIds.push(a.id);
      }
      // Cache has entries for these users, but none hold the group's external id —
      // a non-empty cache, so the empty-cache guard doesn't apply.
      for (let i = 0; i < 10; i++) {
        await prisma.platformExternalUser.create({
          data: {
            platform: 'redash',
            externalId: `ext-cap-${i}`,
            email: `cap${i}@bachatt.app`,
            name: `User ${i}`,
            externalGroupIds: [],
            lastSyncedAt: new Date(),
          },
        });
      }

      const blocked = await resyncRedashMemberships({ platform: 'redash', apply: true, ...performer });
      expect(blocked.removePassBlockedBySafetyCap).toBe(true);
      expect(blocked.removePassOrphansFound).toBe(10); // found count, for messaging...
      expect(blocked.grantsDeactivated).toBe(0); // ...but grantsDeactivated reflects reality: nothing written
      expect(blocked.deactivatedGrants.length).toBe(10); // the review list stays populated regardless
      for (const id of accessIds) {
        const row = await prisma.userAccess.findUnique({ where: { id } });
        expect(row?.isActive).toBe(true); // ...but nothing was actually written
      }

      const forced = await resyncRedashMemberships({ platform: 'redash', apply: true, force: true, ...performer });
      expect(forced.removePassBlockedBySafetyCap).toBe(false);
      expect(forced.grantsDeactivated).toBe(10);
      for (const id of accessIds) {
        const row = await prisma.userAccess.findUnique({ where: { id } });
        expect(row?.isActive).toBe(false);
      }
    });
  });

  describe('Pass C — fix stuck requests', () => {
    it('flips a WAITING_FOR_SETUP request to PROVISIONED once the matching grant + level are confirmed', async () => {
      const group = await prisma.group.create({
        data: { name: 'Growth', slug: 'growth', description: 'd', platform: 'redash', externalGroupId: 'ext-growth' },
      });

      const request = await prisma.accessRequest.create({
        data: {
          groupId: group.id,
          requesterId: 'usr-stuck',
          requesterName: 'Stuck User',
          requesterEmail: 'stuck@bachatt.app',
          justification: 'need it',
          status: RequestStatus.WAITING_FOR_SETUP,
        },
      });

      // The grant already exists (e.g. created out-of-band) matching the request's group+level.
      await prisma.userAccess.create({
        data: {
          userId: 'usr-stuck',
          userName: 'Stuck User',
          userEmail: 'stuck@bachatt.app',
          groupId: group.id,
          externalUserId: 'ext-user-4',
          isActive: true,
          grantedBy: 'system_import',
        },
      });
      // Cache says the user really is in the group now (not consulted directly by
      // Pass C, but keeps the platform state consistent with Pass B's checks).
      await prisma.platformExternalUser.create({
        data: {
          platform: 'redash',
          externalId: 'ext-user-4',
          email: 'stuck@bachatt.app',
          name: 'Stuck User',
          externalGroupIds: ['ext-growth'],
          lastSyncedAt: new Date(),
        },
      });

      const applied = await resyncRedashMemberships({ platform: 'redash', apply: true, ...performer });
      expect(applied.requestsReconciled).toBe(1);
      expect(applied.reconciledRequests).toEqual(['stuck@bachatt.app → Growth (was WAITING_FOR_SETUP)']);

      const updated = await prisma.accessRequest.findUnique({ where: { id: request.id } });
      expect(updated?.status).toBe(RequestStatus.PROVISIONED);
      expect(updated?.provisionedAt).not.toBeNull();

      const audit = await prisma.auditEntry.findFirst({ where: { action: 'ACCESS_GRANTED', accessRequestId: request.id } });
      expect(audit).not.toBeNull();
    });

    it('reports (but does not close) a stuck request with no matching active grant', async () => {
      const group = await prisma.group.create({
        data: { name: 'Growth', slug: 'growth', description: 'd', platform: 'redash', externalGroupId: 'ext-growth' },
      });
      const request = await prisma.accessRequest.create({
        data: {
          groupId: group.id,
          requesterId: 'usr-still-stuck',
          requesterName: 'Still Stuck',
          requesterEmail: 'still-stuck@bachatt.app',
          justification: 'need it',
          status: RequestStatus.PROVISION_FAILED,
        },
      });

      const applied = await resyncRedashMemberships({ platform: 'redash', apply: true, ...performer });
      expect(applied.requestsReconciled).toBe(0);
      expect(applied.stuckReported.length).toBe(1);
      expect(applied.stuckReported[0]).toContain('still-stuck@bachatt.app');

      const unchanged = await prisma.accessRequest.findUnique({ where: { id: request.id } });
      expect(unchanged?.status).toBe(RequestStatus.PROVISION_FAILED);
    });
  });

  describe('Pass D — account request drift (report-only)', () => {
    it('flags a REJECTED account request whose user already has a working Redash account, without touching it', async () => {
      const request = await prisma.userCreationRequest.create({
        data: {
          userId: 'usr-bypassed',
          userName: 'Bypassed User',
          userEmail: 'bypassed@bachatt.app',
          platform: 'redash',
          status: 'REJECTED',
          justification: 'need it',
        },
      });
      // The senior created the account directly on Redash despite the rejection.
      await prisma.platformExternalUser.create({
        data: {
          platform: 'redash',
          externalId: 'ext-bypassed',
          email: 'bypassed@bachatt.app',
          name: 'Bypassed User',
          externalGroupIds: [],
          lastSyncedAt: new Date(),
        },
      });

      const applied = await resyncRedashMemberships({ platform: 'redash', apply: true, ...performer });
      expect(applied.accountRequestDrift.length).toBe(1);
      expect(applied.accountRequestDrift[0]).toContain('bypassed@bachatt.app');
      expect(applied.accountRequestDrift[0]).toContain('REJECTED');

      // Never auto-resolved — the deliberate REJECTED decision is left alone.
      const unchanged = await prisma.userCreationRequest.findUnique({ where: { id: request.id } });
      expect(unchanged?.status).toBe('REJECTED');
    });

    it('does not flag a request whose user has no matching cache entry', async () => {
      await prisma.userCreationRequest.create({
        data: {
          userId: 'usr-not-bypassed',
          userName: 'Not Bypassed',
          userEmail: 'not-bypassed@bachatt.app',
          platform: 'redash',
          status: 'PENDING',
          justification: 'need it',
        },
      });

      const applied = await resyncRedashMemberships({ platform: 'redash', apply: true, ...performer });
      expect(applied.accountRequestDrift).toEqual([]);
    });
  });

  describe('Concurrency lock', () => {
    it('rejects a second concurrent resync for the same platform', async () => {
      const results = await Promise.allSettled([
        resyncRedashMemberships({ platform: 'redash', apply: false, ...performer }),
        resyncRedashMemberships({ platform: 'redash', apply: false, ...performer }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toContain('already running');
    });

    it('allows a resync after the previous one for the same platform has finished', async () => {
      await resyncRedashMemberships({ platform: 'redash', apply: false, ...performer });
      // The lock must have been released — this should not throw.
      await expect(resyncRedashMemberships({ platform: 'redash', apply: false, ...performer })).resolves.toBeDefined();
    });
  });
});
