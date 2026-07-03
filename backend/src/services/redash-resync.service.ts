/**
 * Redash Full Resync — a manually-triggered maintenance tool (NOT a cron job)
 * that makes Hermes match Redash reality in both directions after someone edits
 * Redash directly instead of going through Hermes (adds/removes a group member,
 * moves someone to a different permission level, disables/deletes/recreates a
 * user). Extends the one-way `importRedashMemberships` backfill with more passes:
 *
 *  Pass A — ADD (delegates to importRedashMemberships): creates COMPLETED
 *    UserCreationRequests + ACTIVE UserAccess grants for Redash memberships
 *    Hermes doesn't know about yet. Also refreshes the platform cache
 *    (syncGroups/syncUsers) and reconciles Hermes group externalGroupIds.
 *    Note: syncUsers() also drives `handlePlatformUserDetected`, which already
 *    auto-advances AWAITING_SETUP/APPROVED UserCreationRequests to COMPLETED
 *    whenever the matching platform user shows up — nothing new needed here.
 *  Pass B — REMOVE / SWAP / REPAIR, over every ACTIVE UserAccess grant:
 *    - REFRESH: the grant's externalUserId is stale (its user was deleted and
 *      recreated on Redash — same email, new id) but the membership still
 *      holds — repoint the grant instead of treating it as gone.
 *    - SWAP: the user moved to a DIFFERENT level of the SAME Hermes group
 *      directly on Redash (e.g. Junior → Senior). Pass A's grant-creation
 *      only checks "does an active grant already exist for this group" (not
 *      which level), so without this the user would end up with zero access
 *      until a second resync run. Deactivates the old grant + creates the new
 *      one atomically, carrying over the original expiry.
 *    - REMOVE: everything else that's no longer a member anywhere in the
 *      group, OR whose Redash account is now disabled, is deactivated. No
 *      platform call — the membership/account is already gone/disabled.
 *  Pass C — FIX STUCK: flips AccessRequests stuck in WAITING_FOR_SETUP /
 *    PROVISIONING / PROVISION_FAILED to PROVISIONED when the requester's
 *    membership is now confirmed (via Pass A's grant creation).
 *  Pass D — ACCOUNT REQUEST DRIFT (report-only): flags UserCreationRequests
 *    in DRAFT/PENDING/REJECTED whose user already has a working Redash
 *    account — e.g. an admin rejected the request but someone created the
 *    account directly on Redash anyway. Never auto-resolved: a REJECTED
 *    status is a deliberate decision, so this surfaces for human review
 *    instead of silently overriding it.
 *
 * SAFETY:
 *  - DRY RUN unless { apply: true }. Same report shape either way.
 *  - Concurrency lock: only one resync (dry-run or apply) per platform runs at
 *    a time — a second call while one is in flight throws ConflictError
 *    immediately instead of racing writes. Scoped to this tool only; it does
 *    NOT coordinate with the periodic cron sync (that's a bigger change for a
 *    single-instance app where the worst case is a harmless duplicate audit
 *    row — not worth the added complexity here).
 *  - Empty-cache guard: if the refreshed Redash user cache is empty, Pass B is
 *    skipped entirely (never deactivate everyone off of a bad/empty fetch).
 *  - Health-check gate: Pass B also skips if the platform's healthCheck()
 *    reports unhealthy (or the probe itself throws) — a "200 OK but degraded"
 *    response can look like real data without actually being trustworthy.
 *  - Safety cap: if REMOVE would deactivate more than max(5, 20% of active
 *    grants) in one run, Apply refuses to write those removals (report still
 *    shows exactly what was blocked) unless { force: true } is passed. A
 *    partial/truncated Redash fetch looks exactly like "everyone left" —
 *    this is the backstop for that. REFRESH and SWAP are corrective, not
 *    destructive, so they're never gated by the cap.
 *  - Pass B only touches grants whose group/level has a resolvable
 *    externalGroupId — an unmapped grant is skipped and reported, never
 *    deactivated.
 *  - Per-item error isolation: one grant/request failing to write is caught
 *    and recorded in `errors`, not allowed to abort the rest of the run.
 *  - Requires Redash LIVE + Keycloak LIVE (enforced inside importRedashMemberships,
 *    which throws ConflictError otherwise — this function doesn't re-check).
 */
import prisma from '../config/prisma';
import { RequestStatus, UserCreationStatus, Prisma } from '@prisma/client';
import { importRedashMemberships, RedashImportReport } from './redash-import.service';
import provisioningRegistry from './provisioning.registry';
import { ConflictError } from '../utils/errors';
import logger from '../utils/logger';

export interface RedashResyncReport extends RedashImportReport {
  // Pass B — remove (includes both "no longer a member" and "account disabled")
  grantsDeactivated: number;
  grantsDeactivatedDisabled: number;
  deactivatedGrants: string[];
  activeGrantsSkippedUnmapped: string[];
  removePassSkippedEmptyCache: boolean;
  removePassSkippedUnhealthy: boolean;
  removePassUnhealthyMessage: string | null;
  removePassBlockedBySafetyCap: boolean;
  removePassSafetyCapThreshold: number | null;
  // Pass B — level swap (user moved to a different level's Redash group directly)
  levelsSwapped: number;
  swappedGrants: string[];
  // Pass B — stale externalUserId repair (user deleted + recreated on Redash)
  externalUserIdsRefreshed: number;
  refreshedExternalUserIds: string[];
  // Pass C — fix stuck
  requestsReconciled: number;
  reconciledRequests: string[];
  stuckReported: string[];
  // Pass D — account-request drift (report-only)
  accountRequestDrift: string[];
  // Cross-cutting: per-item write failures that didn't abort the run
  errors: string[];
}

const STUCK_STATUSES: RequestStatus[] = [
  RequestStatus.WAITING_FOR_SETUP,
  RequestStatus.PROVISIONING,
  RequestStatus.PROVISION_FAILED,
];

// UserCreationRequest statuses where Hermes believes the user does NOT have a
// completed account — if the platform cache shows otherwise, that's drift.
const DRIFT_SUSPECT_STATUSES: UserCreationStatus[] = [
  UserCreationStatus.DRAFT,
  UserCreationStatus.PENDING,
  UserCreationStatus.REJECTED,
];

// Refuse to auto-deactivate more than this share of a platform's active
// grants in one Apply — see the "Safety cap" note above.
const SAFETY_CAP_MIN_ABSOLUTE = 5;
const SAFETY_CAP_RATIO = 0.2;

// One resync per platform at a time — see "Concurrency lock" note above.
const inFlight = new Set<string>();

type GrantWithGroupAndLevel = Prisma.UserAccessGetPayload<{
  include: { group: { include: { levels: true } }; level: true };
}>;

type AlternateTarget = { levelId: string | null; levelName: string | null; externalGroupId: string };
type OrphanReason = 'removed' | 'disabled';

/**
 * A grant's own group/level is no longer in the user's cached memberships —
 * check whether they're actually in a DIFFERENT level of the SAME group
 * (moved directly on Redash) before concluding the access is just gone.
 * Prefers the highest-rank matching level, same "keep the more senior one"
 * rule importRedashMemberships uses when a user's memberships span levels.
 */
function resolveAlternateTarget(
  group: GrantWithGroupAndLevel['group'],
  excludeExternalGroupId: string,
  cachedGroupIds: Set<string>,
): AlternateTarget | null {
  const levelCandidates = group.levels
    .filter((l) => l.isActive && l.externalGroupId && l.externalGroupId !== excludeExternalGroupId && cachedGroupIds.has(l.externalGroupId))
    .sort((a, b) => b.rank - a.rank);
  if (levelCandidates.length > 0) {
    const l = levelCandidates[0];
    return { levelId: l.id, levelName: l.name, externalGroupId: l.externalGroupId! };
  }
  if (group.externalGroupId && group.externalGroupId !== excludeExternalGroupId && cachedGroupIds.has(group.externalGroupId)) {
    return { levelId: null, levelName: null, externalGroupId: group.externalGroupId };
  }
  return null;
}

export async function resyncRedashMemberships(opts: {
  platform?: string;
  apply: boolean;
  force?: boolean;
  performerId: string;
  performerName: string;
}): Promise<RedashResyncReport> {
  const { apply, force = false } = opts;
  const lowerPlatform = (opts.platform ?? 'redash').toLowerCase();
  const displayName = lowerPlatform === 'redash-qa' ? 'Redash QA' : 'Redash';

  if (inFlight.has(lowerPlatform)) {
    throw new ConflictError(`A ${displayName} resync is already running — try again in a moment.`);
  }
  inFlight.add(lowerPlatform);

  try {
    return await runResync({ ...opts, apply, force, lowerPlatform, displayName });
  } finally {
    inFlight.delete(lowerPlatform);
  }
}

async function runResync(opts: {
  apply: boolean;
  force: boolean;
  lowerPlatform: string;
  displayName: string;
  platform?: string;
  performerId: string;
  performerName: string;
}): Promise<RedashResyncReport> {
  const { apply, force, lowerPlatform, displayName } = opts;
  const now = new Date();

  // ── Pass A — ADD. Also refreshes the platform cache + Hermes group links,
  //    which Pass B, C, and D all depend on.
  const importReport = await importRedashMemberships(opts);

  const report: RedashResyncReport = {
    ...importReport,
    grantsDeactivated: 0,
    grantsDeactivatedDisabled: 0,
    deactivatedGrants: [],
    activeGrantsSkippedUnmapped: [],
    removePassSkippedEmptyCache: false,
    removePassSkippedUnhealthy: false,
    removePassUnhealthyMessage: null,
    removePassBlockedBySafetyCap: false,
    removePassSafetyCapThreshold: null,
    levelsSwapped: 0,
    swappedGrants: [],
    externalUserIdsRefreshed: 0,
    refreshedExternalUserIds: [],
    requestsReconciled: 0,
    reconciledRequests: [],
    stuckReported: [],
    accountRequestDrift: [],
    errors: [],
  };

  // Cache is read once and shared by Pass B (membership/disabled checks) and
  // Pass D (account-existence checks), regardless of whether Pass B itself runs.
  const cachedUsers = await prisma.platformExternalUser.findMany({ where: { platform: lowerPlatform } });
  const cachedByEmail = new Map(cachedUsers.map((u) => [u.email.toLowerCase(), u]));

  // ── Pass B — REMOVE / SWAP / REPAIR ──────────────────────────────────────
  if (cachedUsers.length === 0) {
    report.removePassSkippedEmptyCache = true;
    logger.warn(
      `${displayName} resync: platform cache is empty after refresh — skipping the remove pass to avoid deactivating everyone.`,
    );
  } else {
    let healthy = true;
    let healthMessage: string | undefined;
    try {
      const provisioner = provisioningRegistry.get(lowerPlatform);
      const health = await provisioner.healthCheck();
      healthy = health.healthy;
      healthMessage = health.message;
    } catch (err: any) {
      healthy = false;
      healthMessage = err.message;
    }

    if (!healthy) {
      report.removePassSkippedUnhealthy = true;
      report.removePassUnhealthyMessage = healthMessage ?? null;
      logger.warn(
        `${displayName} resync: platform health check failed (${healthMessage ?? 'no message'}) — skipping the remove pass, ` +
          'a degraded response can look like valid data without being trustworthy.',
      );
    } else {
      const cachedByExternalId = new Map(cachedUsers.map((u) => [u.externalId, u]));

      const activeGrants = await prisma.userAccess.findMany({
        where: { isActive: true, group: { platform: lowerPlatform } },
        include: { group: { include: { levels: true } }, level: true },
      });

      // Classify every grant BEFORE writing anything, so the safety cap sees
      // the true removal count up front — checking it after partial writes
      // would be meaningless.
      const orphans: { grant: GrantWithGroupAndLevel; label: string; reason: OrphanReason }[] = [];
      const swaps: { grant: GrantWithGroupAndLevel; label: string; target: AlternateTarget; freshExternalId: string }[] = [];
      const refreshes: { grant: GrantWithGroupAndLevel; newExternalId: string }[] = [];

      for (const grant of activeGrants) {
        const label = grant.level ? `${grant.group.name} — ${grant.level.name}` : grant.group.name;
        const externalGroupId = grant.level?.externalGroupId ?? grant.group.externalGroupId;

        if (!externalGroupId || !grant.externalUserId) {
          report.activeGrantsSkippedUnmapped.push(`${grant.userEmail} → ${label}`);
          continue;
        }

        let cachedUser = cachedByExternalId.get(grant.externalUserId);
        let externalUserIdStale = false;
        if (!cachedUser) {
          // The grant's externalUserId may be stale (user deleted + recreated on
          // Redash with a new id, same email) — fall back to email before
          // concluding the membership is gone entirely.
          const byEmail = cachedByEmail.get(grant.userEmail.toLowerCase());
          if (byEmail && byEmail.externalId !== grant.externalUserId) {
            cachedUser = byEmail;
            externalUserIdStale = true;
          }
        }

        const cachedGroupIds = new Set(cachedUser?.externalGroupIds ?? []);
        const isDisabled = !!cachedUser?.isDisabled;
        const stillMember = cachedGroupIds.has(externalGroupId);

        if (stillMember && !isDisabled) {
          if (externalUserIdStale && cachedUser) {
            refreshes.push({ grant, newExternalId: cachedUser.externalId });
          }
          continue;
        }

        if (isDisabled && cachedUser) {
          // Disabled directly on Redash — deactivate regardless of which
          // group(s) they're nominally still a member of; a disabled account
          // can't use the platform, so the grant shouldn't stay active.
          orphans.push({ grant, label, reason: 'disabled' });
          continue;
        }

        const altTarget = resolveAlternateTarget(grant.group, externalGroupId, cachedGroupIds);
        if (altTarget && cachedUser) {
          swaps.push({ grant, label, target: altTarget, freshExternalId: cachedUser.externalId });
          continue;
        }

        orphans.push({ grant, label, reason: 'removed' });
      }

      report.levelsSwapped = swaps.length;
      report.swappedGrants = swaps.map(
        (s) => `${s.grant.userEmail} → ${s.grant.group.name}: ${s.grant.level?.name ?? '(base)'} → ${s.target.levelName ?? '(base)'}`,
      );
      report.externalUserIdsRefreshed = refreshes.length;
      report.refreshedExternalUserIds = refreshes.map((r) => {
        const grantLabel = r.grant.level ? `${r.grant.group.name} — ${r.grant.level.name}` : r.grant.group.name;
        return `${r.grant.userEmail} → ${grantLabel} (${r.grant.externalUserId} → ${r.newExternalId})`;
      });

      // Refresh + swap are corrective (they never reduce anyone's access) —
      // they always proceed, regardless of the removal safety cap below.
      for (const r of refreshes) {
        if (!apply) continue;
        try {
          await prisma.userAccess.update({ where: { id: r.grant.id }, data: { externalUserId: r.newExternalId } });
        } catch (err: any) {
          report.errors.push(`refresh externalUserId for ${r.grant.userEmail}: ${err.message}`);
        }
      }

      for (const s of swaps) {
        logger.info(
          `  ${apply ? '⇄' : 'would swap'} grant: ${s.grant.userEmail} → ${s.grant.group.name} (${s.grant.level?.name ?? 'base'} → ${s.target.levelName ?? 'base'})`,
        );
        if (!apply) continue;
        try {
          await prisma.$transaction(async (tx) => {
            await tx.userAccess.update({ where: { id: s.grant.id }, data: { isActive: false, revokedAt: now } });
            await tx.userAccess.create({
              data: {
                userId: s.grant.userId,
                userName: s.grant.userName,
                userEmail: s.grant.userEmail,
                groupId: s.grant.groupId,
                levelId: s.target.levelId,
                externalUserId: s.freshExternalId,
                isActive: true,
                grantedAt: now,
                expiresAt: s.grant.expiresAt, // carry over — don't silently convert a temp grant into permanent
                grantedBy: 'system_resync',
                accessRequestId: null,
              },
            });
            if (s.grant.accessRequestId) {
              await tx.accessRequest.update({
                where: { id: s.grant.accessRequestId },
                data: {
                  status: RequestStatus.REVOKED,
                  revokeReason: `${displayName} resync: level changed directly on ${displayName} (${s.grant.level?.name ?? 'base'} → ${s.target.levelName ?? 'base'})`,
                  revokedAt: now,
                },
              });
            }
          });
          await prisma.auditEntry.create({
            data: {
              action: 'ACCESS_LEVEL_CHANGED',
              performerId: opts.performerId,
              performerName: opts.performerName,
              targetUserId: s.grant.userId,
              targetUserName: s.grant.userName,
              groupId: s.grant.groupId,
              details: {
                fromLevelId: s.grant.levelId ?? null,
                fromLevelName: s.grant.level?.name ?? null,
                toLevelId: s.target.levelId,
                toLevelName: s.target.levelName,
                source: `${lowerPlatform}-resync`,
              },
            },
          });
        } catch (err: any) {
          report.errors.push(`swap level for ${s.grant.userEmail} on ${s.label}: ${err.message}`);
        }
      }

      // Safety cap: refuse to silently deactivate a large slice of a platform's
      // active grants in one run — a bad/partial Redash fetch (API hiccup, a
      // pagination bug, pointing at the wrong instance) looks exactly like
      // "everyone left." Dry run always shows the full picture; only a real
      // Apply is blocked, and only the destructive removal step.
      const threshold = Math.max(SAFETY_CAP_MIN_ABSOLUTE, Math.ceil(activeGrants.length * SAFETY_CAP_RATIO));
      report.removePassSafetyCapThreshold = threshold;
      const overCap = orphans.length > threshold;

      report.grantsDeactivated = orphans.length;
      report.grantsDeactivatedDisabled = orphans.filter((o) => o.reason === 'disabled').length;
      report.deactivatedGrants = orphans.map(
        (o) => `${o.grant.userEmail} → ${o.label} (${o.reason === 'disabled' ? `disabled on ${displayName}` : `no longer on ${displayName}`})`,
      );

      if (apply && overCap && !force) {
        report.removePassBlockedBySafetyCap = true;
        logger.warn(
          `${displayName} resync: remove pass blocked — ${orphans.length} grant(s) would be deactivated, over the safety cap of ${threshold} ` +
            `(${Math.round(SAFETY_CAP_RATIO * 100)}% of ${activeGrants.length} active grants). Re-run with force to proceed.`,
        );
      } else {
        for (const o of orphans) {
          const reasonText = o.reason === 'disabled' ? `disabled on ${displayName}` : `no longer on ${displayName}`;
          logger.info(`  ${apply ? '－' : 'would deactivate'} grant: ${o.grant.userEmail} → ${o.label} (${reasonText})`);
          if (!apply) continue;
          try {
            await prisma.userAccess.update({ where: { id: o.grant.id }, data: { isActive: false, revokedAt: now } });
            if (o.grant.accessRequestId) {
              await prisma.accessRequest.update({
                where: { id: o.grant.accessRequestId },
                data: {
                  status: RequestStatus.REVOKED,
                  revokeReason: `${displayName} resync: ${o.reason === 'disabled' ? 'account disabled on' : 'membership no longer present on'} ${displayName}`,
                  revokedAt: now,
                },
              });
            }
            await prisma.auditEntry.create({
              data: {
                action: 'ACCESS_REVOKED',
                performerId: opts.performerId,
                performerName: opts.performerName,
                targetUserId: o.grant.userId,
                targetUserName: o.grant.userName,
                groupId: o.grant.groupId,
                accessRequestId: o.grant.accessRequestId,
                details: {
                  reason: `${displayName} resync: ${reasonText}`,
                  userAccessId: o.grant.id,
                  levelId: o.grant.levelId ?? null,
                  levelName: o.grant.level?.name ?? null,
                  source: `${lowerPlatform}-resync`,
                  orphanReason: o.reason,
                },
              },
            });
          } catch (err: any) {
            report.errors.push(`deactivate grant for ${o.grant.userEmail} on ${o.label}: ${err.message}`);
          }
        }
      }
    }
  }

  // ── Pass C — FIX STUCK ───────────────────────────────────────────────────
  const stuckRequests = await prisma.accessRequest.findMany({
    where: { status: { in: STUCK_STATUSES }, group: { platform: lowerPlatform } },
    include: { group: true, level: true },
  });

  for (const req of stuckRequests) {
    const label = req.level ? `${req.group.name} — ${req.level.name}` : req.group.name;
    const activeGrant = await prisma.userAccess.findFirst({
      where: { userId: req.requesterId, groupId: req.groupId, isActive: true },
    });
    const levelMatches = !!activeGrant && activeGrant.levelId === req.levelId;

    if (!levelMatches) {
      report.stuckReported.push(
        `${req.requesterEmail} → ${label} (${req.status})${
          activeGrant ? ' — active grant is on a different level' : ` — user not yet a member on ${displayName}`
        }`,
      );
      continue;
    }

    report.requestsReconciled++;
    report.reconciledRequests.push(`${req.requesterEmail} → ${label} (was ${req.status})`);
    logger.info(`  ${apply ? '✓' : 'would reconcile'} request: ${req.requesterEmail} → ${label} (${req.status} → PROVISIONED)`);

    if (!apply) continue;
    try {
      await prisma.accessRequest.update({
        where: { id: req.id },
        data: { status: RequestStatus.PROVISIONED, provisionedAt: now, provisionError: null },
      });
      await prisma.auditEntry.create({
        data: {
          action: 'ACCESS_GRANTED',
          performerId: opts.performerId,
          performerName: opts.performerName,
          targetUserId: req.requesterId,
          targetUserName: req.requesterName,
          groupId: req.groupId,
          accessRequestId: req.id,
          details: {
            levelId: req.levelId ?? null,
            levelName: req.level?.name ?? null,
            source: `${lowerPlatform}-resync`,
            note: `Request was stuck in ${req.status}; membership confirmed on ${displayName} by resync.`,
          },
        },
      });
    } catch (err: any) {
      report.errors.push(`reconcile stuck request for ${req.requesterEmail} on ${label}: ${err.message}`);
    }
  }

  // ── Pass D — ACCOUNT REQUEST DRIFT (report-only) ────────────────────────
  // A DRAFT/PENDING/REJECTED account request whose user already has a working
  // Redash account means Hermes' record disagrees with reality — most notably
  // a rejection that got bypassed by creating the account directly. Never
  // auto-resolved: flip these deliberately, not silently.
  const suspectRequests = await prisma.userCreationRequest.findMany({
    where: { platform: lowerPlatform, status: { in: DRIFT_SUSPECT_STATUSES } },
  });
  for (const req of suspectRequests) {
    const cached = cachedByEmail.get(req.userEmail.toLowerCase());
    if (cached) {
      report.accountRequestDrift.push(
        `${req.userEmail}: Hermes status is ${req.status} but the account already exists on ${displayName} (external id ${cached.externalId}) — review needed`,
      );
    }
  }

  logger.info(
    `${displayName} resync ${apply ? 'applied' : 'dry-run'}: created=${report.grantsCreated}, ` +
      `deactivated=${report.grantsDeactivated} (disabled=${report.grantsDeactivatedDisabled}), swapped=${report.levelsSwapped}, ` +
      `refreshed=${report.externalUserIdsRefreshed}, requestsReconciled=${report.requestsReconciled}, ` +
      `stuckUnresolved=${report.stuckReported.length}, accountDrift=${report.accountRequestDrift.length}, errors=${report.errors.length}`,
  );

  return report;
}
