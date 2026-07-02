/**
 * One-shot importer: backfill existing Redash QA accounts + group memberships into
 * Hermes so users keep the access they already have, without re-requesting.
 *
 * WHAT IT DOES (per real Redash QA user, after refreshing the live cache):
 *  1. Resolves the user's Hermes identity (Keycloak `sub`) from their email.
 *     A Redash QA user with no Keycloak account can't own a Hermes grant, so they
 *     are SKIPPED and reported (you decide whether to onboard them to Keycloak).
 *  2. Upserts a COMPLETED UserCreationRequest for (user, redash-qa) so the account
 *     gate is satisfied — they never see the "create your Redash QA account" flow.
 *  3. For each of their Redash QA group memberships, maps the Redash QA group id to the
 *     Hermes group/level that backs it (via externalGroupId) and creates an ACTIVE,
 *     PERMANENT UserAccess grant. No platform re-provisioning happens — the user is
 *     already in that Redash QA group; we are only recording the existing reality.
 *
 * SAFETY:
 *  - DRY RUN BY DEFAULT. It prints exactly what it would create and writes nothing.
 *    Re-run with `--apply` to actually write.
 *  - IDEMPOTENT. An existing active grant or completed account-request is left
 *    untouched, so it's safe to run more than once.
 *
 * REQUIREMENTS (it aborts loudly otherwise):
 *  - Redash QA must be LIVE (real REDASH_QA_API_KEY, REDASH_QA_SIMULATION not "true") — else
 *    the "users" are the in-process mock.
 *  - Keycloak must be LIVE (admin credential set) — needed to resolve email → sub.
 *
 * RUN (from backend/):
 *    npx ts-node scripts/import-redash-qa-memberships.ts          # dry run
 *    npx ts-node scripts/import-redash-qa-memberships.ts --apply  # write
 */
import { loadSecrets } from '../src/config/secrets';

const PLATFORM = 'redash-qa';
const APPLY = process.argv.includes('--apply');

/** A Hermes grant target a Redash QA group id maps to. rank = level rank (-1 = base, level-less). */
interface Target {
  groupId: string;
  groupName: string;
  levelId: string | null;
  levelName: string | null;
  rank: number;
}

async function main(): Promise<void> {
  // Populate process.env from AWS Secrets Manager in prod (no-op in dev — uses .env).
  // Must run before importing services that read config at module load.
  await loadSecrets();

  // Dynamic imports AFTER loadSecrets so each module's import-time config reads see
  // the live values (same reason app.ts bootstraps services dynamically).
  const { default: prisma } = await import('../src/config/prisma');
  const { default: provisioningRegistry } = await import(
    '../src/services/provisioning.registry'
  );
  const { default: syncService } = await import('../src/services/sync.service');
  const { default: keycloakAdminService } = await import(
    '../src/services/keycloak-admin.service'
  );
  const { default: logger } = await import('../src/utils/logger');

  logger.info(
    `🚚 Redash QA membership import — ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`,
  );

  // ── Guards ──────────────────────────────────────────────────────────────────
  if (!provisioningRegistry.has(PLATFORM)) {
    logger.error(
      'Redash QA is not registered in the provisioning registry. Please configure REDASH_QA_BASE_URL.',
    );
    process.exit(1);
  }
  const redashQaProvisioner = provisioningRegistry.get(PLATFORM);

  if (redashQaProvisioner.isSimulation?.()) {
    logger.error(
      'Redash QA is in SIMULATION mode. Set a real REDASH_QA_API_KEY and REDASH_QA_SIMULATION=false before importing.',
    );
    process.exit(1);
  }
  if (!keycloakAdminService.isLive) {
    logger.error(
      'Keycloak is not live (no admin credential). It is required to resolve each Redash QA email to a Hermes user id.',
    );
    process.exit(1);
  }

  // ── 1. Refresh live state: cache the real Redash QA users/groups, then reconcile
  //       Hermes groups so their externalGroupId actually points at real Redash QA ids.
  logger.info(
    'Refreshing Redash QA groups + users and reconciling Hermes groups…',
  );
  await redashQaProvisioner.syncGroups?.();
  await redashQaProvisioner.syncUsers?.();
  await syncService.reconcileHermesGroups(PLATFORM, redashQaProvisioner);

  // ── 2. Build externalGroupId → Hermes grant target. A Group's own externalGroupId
  //       is a level-less grant; each active level's externalGroupId is a leveled grant.
  const groups = await prisma.group.findMany({
    where: { platform: PLATFORM, isActive: true },
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
      if (l.isActive && l.externalGroupId) {
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
    `Mapped ${targetByExtId.size} Redash QA group id(s) to Hermes groups/levels.`,
  );

  // ── 3. Walk the cached Redash QA users (populated by syncUsers above).
  const users = await prisma.platformExternalUser.findMany({
    where: { platform: PLATFORM },
  });
  logger.info(`Found ${users.length} cached Redash QA user(s).`);

  const report = {
    usersMatched: 0,
    usersSkippedNoKeycloak: [] as string[],
    usersSkippedDisabled: [] as string[],
    accountRequestsCreated: 0,
    grantsCreated: 0,
    grantsAlreadyPresent: 0,
    membershipsUnmapped: [] as string[],
    levelConflicts: [] as string[],
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
      where: { userId_platform: { userId: sub, platform: PLATFORM } },
    });
    if (!existingReq) {
      report.accountRequestsCreated++;
      if (APPLY) {
        await prisma.userCreationRequest.create({
          data: {
            userId: sub,
            userName,
            userEmail: u.email,
            platform: PLATFORM,
            justification: 'Imported: pre-existing Redash QA account',
            status: 'COMPLETED',
            externalUserId: u.externalId,
            reviewerId: 'system_import',
            reviewerName: 'Redash QA Import',
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
        report.membershipsUnmapped.push(`${u.email} → redash-qa group ${extId}`);
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
      const label = t.levelName
        ? `${t.groupName} — ${t.levelName}`
        : t.groupName;
      logger.info(
        `  ${APPLY ? '＋' : 'would add'} grant: ${u.email} → ${label}`,
      );
      if (APPLY) {
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
            performerName: 'Redash QA Import',
            targetUserId: sub,
            targetUserName: userName,
            details: {
              platform: PLATFORM,
              groupId: t.groupId,
              groupName: t.groupName,
              levelId: t.levelId,
              levelName: t.levelName,
              externalUserId: u.externalId,
              source: 'redash-qa-membership-import',
            },
          },
        });
      }
    }
  }

  // ── 4. Report ────────────────────────────────────────────────────────────────
  logger.info('──────────────────────────────────────────────');
  logger.info(`Users matched to a Keycloak identity: ${report.usersMatched}`);
  logger.info(
    `Account-creation requests ${APPLY ? 'created' : 'to create'}: ${report.accountRequestsCreated}`,
  );
  logger.info(
    `Grants ${APPLY ? 'created' : 'to create'}: ${report.grantsCreated}`,
  );
  logger.info(
    `Grants already present (skipped): ${report.grantsAlreadyPresent}`,
  );
  if (report.usersSkippedDisabled.length) {
    logger.warn(
      `Skipped ${report.usersSkippedDisabled.length} DISABLED Redash QA user(s): ${report.usersSkippedDisabled.join(', ')}`,
    );
  }
  if (report.usersSkippedNoKeycloak.length) {
    logger.warn(
      `Skipped ${report.usersSkippedNoKeycloak.length} user(s) with NO Keycloak identity (no Hermes grant possible): ${report.usersSkippedNoKeycloak.join(', ')}`,
    );
  }
  if (report.membershipsUnmapped.length) {
    logger.warn(
      `${report.membershipsUnmapped.length} membership(s) had no matching Hermes group/level (e.g. Redash QA default/admin, or a group not in Hermes):`,
    );
    report.membershipsUnmapped.forEach(m => logger.warn(`   - ${m}`));
  }
  if (report.levelConflicts.length) {
    logger.warn(
      `${report.levelConflicts.length} level conflict(s) resolved by seniority:`,
    );
    report.levelConflicts.forEach(c => logger.warn(`   - ${c}`));
  }
  logger.info(
    APPLY
      ? '✅ Import complete.'
      : 'ℹ️  Dry run only — nothing was written. Re-run with --apply to commit.',
  );

  await prisma.$disconnect();
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('Redash QA membership import failed:', err);
  process.exit(1);
});
