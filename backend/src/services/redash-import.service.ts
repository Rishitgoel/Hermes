/**
 * Redash membership backfill — a maintenance tool that imports existing Redash
 * accounts + group memberships into Hermes so users keep the access they already
 * have, without re-requesting. Exposed as a service so it can be triggered from
 * the admin UI (a collapsed "Maintenance" disclosure on the Admin Management page)
 * as an alternative to running a background sync job.
 *
 * This is the same logic as a background sync job, minus the loadSecrets()/dynamic-import
 * bootstrap (the running server has already loaded secrets and initialized
 * services). It returns a structured report instead of only logging, so the UI
 * can render the outcome.
 *
 *  - DRY RUN unless { apply: true }. Idempotent: existing active grants and
 *    completed account-requests are left untouched.
 *  - Requires Redash LIVE (real API key, not simulation) and Keycloak LIVE
 *    (admin credential) — it throws ConflictError otherwise.
 */
import prisma from '../config/prisma';
import provisioningRegistry from './provisioning.registry';
import syncService from './sync.service';
import keycloakAdminService from './keycloak-admin.service';
import { ConflictError, ValidationError } from '../utils/errors';
import logger from '../utils/logger';

/** A Hermes grant target a Redash group id maps to. rank = level rank (-1 = base, level-less). */
interface Target {
  groupId: string;
  groupName: string;
  levelId: string | null;
  levelName: string | null;
  rank: number;
}

export interface RedashImportReport {
  apply: boolean;
  mappedGroups: number;
  cachedUsers: number;
  usersMatched: number;
  usersSkippedNoKeycloak: string[];
  usersSkippedDisabled: string[];
  accountRequestsCreated: number;
  grantsCreated: number;
  grantsAlreadyPresent: number;
  membershipsUnmapped: string[];
  levelConflicts: string[];
}

export async function importRedashMemberships(opts: {
  platform?: string;
  apply: boolean;
  performerId: string;
  performerName: string;
}): Promise<RedashImportReport> {
  const { apply, platform = 'redash' } = opts;
  const lowerPlatform = platform.toLowerCase();

  if (lowerPlatform !== 'redash' && lowerPlatform !== 'redash-qa') {
    throw new ValidationError('Invalid platform for membership import');
  }

  const displayName = lowerPlatform === 'redash-qa' ? 'Redash QA' : 'Redash';
  logger.info(
    `🚚 ${displayName} membership import — ${apply ? 'APPLY (writing)' : 'DRY RUN (no writes)'} (by ${opts.performerName})`,
  );

  // ── Guards ──────────────────────────────────────────────────────────────────
  const provisioner = provisioningRegistry.get(lowerPlatform);
  if (provisioner.isSimulation?.()) {
    throw new ConflictError(
      `${displayName} is in SIMULATION mode. Set a real API key and simulation=false before importing.`,
    );
  }
  if (!keycloakAdminService.isLive) {
    throw new ConflictError(
      'Keycloak is not live (no admin credential). It is required to resolve each Redash email to a Hermes user id.',
    );
  }

  // ── 1. Refresh live state: cache the real Redash users/groups, then reconcile
  //       Hermes groups so their externalGroupId actually points at real Redash ids.
  logger.info(
    `Refreshing ${displayName} groups + users and reconciling Hermes groups…`,
  );
  await provisioner.syncGroups?.();
  await provisioner.syncUsers?.();
  await syncService.reconcileHermesGroups(lowerPlatform, provisioner);

  // ── 2. Build externalGroupId → Hermes grant target. A Group's own externalGroupId
  //       is a level-less grant; each level's externalGroupId is a leveled grant.
  //       Full mirror: archived groups/levels (incl. the built-in default/admin) are
  //       included, so the Hermes view matches Redash reality 1:1.
  const groups = await prisma.group.findMany({
    where: { platform: lowerPlatform },
    include: { levels: true },
  });
  const targetByExtId = new Map<string, Target>();
  for (const g of groups) {
    if (g.externalGroupId) {
      targetByExtId.set(g.externalGroupId, {
        groupId: g.id,
        groupName: g.name,
        levelId: null,
        levelName: null,
        rank: -1,
      });
    }
    for (const l of g.levels) {
      if (l.externalGroupId) {
        targetByExtId.set(l.externalGroupId, {
          groupId: g.id,
          groupName: g.name,
          levelId: l.id,
          levelName: l.name,
          rank: l.rank,
        });
      }
    }
  }
  logger.info(
    `Mapped ${targetByExtId.size} ${displayName} group id(s) to Hermes groups/levels.`,
  );

  // ── 3. Walk the cached Redash users (populated by syncUsers above).
  const users = await prisma.platformExternalUser.findMany({ where: { platform: lowerPlatform } });
  logger.info(`Found ${users.length} cached ${displayName} user(s).`);

  const report: RedashImportReport = {
    apply,
    mappedGroups: targetByExtId.size,
    cachedUsers: users.length,
    usersMatched: 0,
    usersSkippedNoKeycloak: [],
    usersSkippedDisabled: [],
    accountRequestsCreated: 0,
    grantsCreated: 0,
    grantsAlreadyPresent: 0,
    membershipsUnmapped: [],
    levelConflicts: [],
  };
  const now = new Date();

  for (const u of users) {
    if (u.isDisabled) {
      report.usersSkippedDisabled.push(u.email);
      continue;
    }
    const sub = await keycloakAdminService.findUserIdByEmail(u.email);
    if (!sub) {
      report.usersSkippedNoKeycloak.push(u.email);
      continue;
    }
    report.usersMatched++;
    const userName = u.name || u.email;

    // 3a. Account gate: COMPLETED UserCreationRequest (idempotent on userId+platform).
    const existingReq = await prisma.userCreationRequest.findUnique({
      where: { userId_platform: { userId: sub, platform: lowerPlatform } },
    });
    if (!existingReq) {
      report.accountRequestsCreated++;
      if (apply) {
        await prisma.userCreationRequest.create({
          data: {
            userId: sub,
            userName,
            userEmail: u.email,
            platform: lowerPlatform,
            justification: `Imported: pre-existing ${displayName} account`,
            status: 'COMPLETED',
            externalUserId: u.externalId,
            reviewerId: 'system_import',
            reviewerName: `${displayName} Import`,
            submittedAt: now,
            approvedAt: now,
            completedAt: now,
          },
        });
      }
    }

    // 3b. Resolve memberships → one grant target per Hermes group (one level/group).
    const perGroup = new Map<string, Target>();
    for (const extId of u.externalGroupIds) {
      const t = targetByExtId.get(extId);
      if (!t) {
        report.membershipsUnmapped.push(`${u.email} → ${lowerPlatform} group ${extId}`);
        continue;
      }
      const existing = perGroup.get(t.groupId);
      if (!existing) {
        perGroup.set(t.groupId, t);
      } else if (t.rank !== existing.rank) {
        // Two Redash memberships map to two levels of the same Hermes group; a user
        // holds one level per group, so keep the higher-ranked (more senior) one.
        const kept = t.rank > existing.rank ? t : existing;
        perGroup.set(t.groupId, kept);
        report.levelConflicts.push(
          `${u.email} → ${t.groupName}: kept "${kept.levelName}" over "${(kept === t ? existing : t).levelName}"`,
        );
      }
    }

    // 3c. Create an active, permanent grant per group (idempotent).
    for (const t of perGroup.values()) {
      const active = await prisma.userAccess.findFirst({
        where: { userId: sub, groupId: t.groupId, isActive: true },
      });
      if (active) {
        report.grantsAlreadyPresent++;
        continue;
      }
      report.grantsCreated++;
      const label = t.levelName ? `${t.groupName} — ${t.levelName}` : t.groupName;
      logger.info(`  ${apply ? '＋' : 'would add'} grant: ${u.email} → ${label}`);
      if (apply) {
        await prisma.userAccess.create({
          data: {
            userId: sub,
            userName,
            userEmail: u.email,
            groupId: t.groupId,
            levelId: t.levelId,
            externalUserId: u.externalId,
            isActive: true,
            grantedAt: now,
            expiresAt: null, // permanent — no expiry on imported memberships
            grantedBy: 'system_import',
            accessRequestId: null,
          },
        });
        await prisma.auditEntry.create({
          data: {
            action: 'ACCESS_IMPORTED',
            performerId: 'system_import',
            performerName: `${displayName} Import`,
            targetUserId: sub,
            targetUserName: userName,
            details: {
              platform: lowerPlatform,
              groupId: t.groupId,
              groupName: t.groupName,
              levelId: t.levelId,
              levelName: t.levelName,
              externalUserId: u.externalId,
              source: `${lowerPlatform}-membership-import`,
            },
          },
        });
      }
    }
  }

  logger.info(
    `${displayName} import ${apply ? 'applied' : 'dry-run'}: matched=${report.usersMatched}, ` +
      `accountReqs=${report.accountRequestsCreated}, grants=${report.grantsCreated}, ` +
      `alreadyPresent=${report.grantsAlreadyPresent}`,
  );
  return report;
}
