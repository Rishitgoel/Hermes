import { describe, it, expect } from 'vitest';
import prisma from '../config/prisma';
import { RedashProvisioner } from './redash.provisioner';

/**
 * Regression coverage for the P2002 crash: a user deleted-and-recreated on
 * Redash keeps their email but gets a new numeric id. Before the fix,
 * buildUserUpsert's upsert-by-externalId couldn't find the new id, so Prisma
 * tried to INSERT a new row, which collided with the stale row's
 * (platform, email) unique constraint and threw — aborting the whole sync
 * (cron sync, manual Sync button, membership import, Full Resync all funnel
 * through syncUsers, so all of them were blocked until someone manually
 * deleted the stale row).
 */
describe('RedashProvisioner.syncUsers — recreated-user email collision', () => {
  const platform = 'redash-test-collision';

  type FakeRedashUser = {
    id: number;
    name: string;
    email: string;
    is_disabled: boolean;
    is_invitation_pending: boolean;
    groups: number[];
  };

  function makeProvisioner(users: FakeRedashUser[]) {
    const mockService = {
      syncUsers: async () => users,
      syncGroups: async () => [],
      getIsSimulation: () => false,
    };
    return new RedashProvisioner({
      platform,
      displayName: 'Redash Test',
      family: 'redash',
      service: mockService as any,
    });
  }

  it('retargets the stale cache row instead of throwing P2002 when a user is recreated with a new id', async () => {
    // Seed the OLD cache row exactly as a prior sync would have left it.
    await prisma.platformExternalUser.create({
      data: {
        platform,
        externalId: '12',
        email: 'recreated@bachatt.app',
        name: 'Recreated User',
        externalGroupIds: ['5'],
        lastSyncedAt: new Date(),
      },
    });

    // Redash now reports the SAME email under a NEW id (deleted + recreated).
    const provisioner = makeProvisioner([
      { id: 45, name: 'Recreated User', email: 'recreated@bachatt.app', is_disabled: false, is_invitation_pending: false, groups: [7] },
    ]);

    // Before the fix this rejected with P2002 on (platform, email).
    const result = await provisioner.syncUsers();
    expect(result.count).toBe(1);

    const rows = await prisma.platformExternalUser.findMany({ where: { platform } });
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe('45');
    expect(rows[0].externalGroupIds).toEqual(['7']);
  });

  it('leaves an unrelated user alone (no collision, normal upsert path)', async () => {
    const provisioner = makeProvisioner([
      { id: 99, name: 'Fresh User', email: 'fresh@bachatt.app', is_disabled: false, is_invitation_pending: false, groups: [] },
    ]);

    const result = await provisioner.syncUsers();
    expect(result.count).toBe(1);

    const row = await prisma.platformExternalUser.findUnique({
      where: { platform_externalId: { platform, externalId: '99' } },
    });
    expect(row).not.toBeNull();
    expect(row?.email).toBe('fresh@bachatt.app');
  });

  it('does not touch a row for the same externalId that has since changed email (normal update path)', async () => {
    await prisma.platformExternalUser.create({
      data: {
        platform,
        externalId: '20',
        email: 'old-email@bachatt.app',
        name: 'Renamed User',
        externalGroupIds: [],
        lastSyncedAt: new Date(),
      },
    });

    // Same externalId, email changed on Redash directly — a normal update, not
    // a recreation, so it should just update in place (no collision to resolve).
    const provisioner = makeProvisioner([
      { id: 20, name: 'Renamed User', email: 'new-email@bachatt.app', is_disabled: false, is_invitation_pending: false, groups: [] },
    ]);

    const result = await provisioner.syncUsers();
    expect(result.count).toBe(1);

    const rows = await prisma.platformExternalUser.findMany({ where: { platform } });
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe('20');
    expect(rows[0].email).toBe('new-email@bachatt.app');
  });
});
