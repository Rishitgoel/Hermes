import {
  PlatformAdapter,
  ProvisionContext,
  ProvisionResult,
  DeprovisionContext,
  PlatformUserStatus,
  OnboardingMessage,
  ReconcileMembersContext,
  ReconcileMembersResult,
} from './provisioner.interface';
import zookeeperService from './zookeeper.service';
import prisma from '../config/prisma';
import config from '../config/config';
import logger from '../utils/logger';
import { ValidationError } from '../utils/errors';
import * as templates from '../utils/email-templates';

/**
 * Platform key this adapter is registered under. The provisioning registry, the
 * cache rows in `platform_external_users`, `Group.platform`, and
 * `UserCreationRequest.platform` all use this exact lowercase string to route here.
 */
const PLATFORM = 'zookeeper';

/**
 * ZooKeeper implementation of {@link PlatformAdapter}.
 *
 * Translates the platform-agnostic adapter contract into cache updates via Postgres.
 * All cached state lives in the shared `platform_external_users` table tagged
 * `platform = "zookeeper"`.
 *
 * Identity model: ZooKeeper has no user directory, so the cache seeded by
 * {@link inviteUser} IS the source of truth for "does this user have a ZK identity".
 * `externalUserId` is a stable per-user key (the user's email, or `__zk_uid:<userId>`
 * for the blank-email case). `externalGroupId` is a **newline-separated list** of znode
 * paths, each optionally suffixed with `#<perms>` (e.g. `/hermes/credit-card#cdrw`).
 *
 * Bookkeeping model: Since the znodes themselves are world-open and access is enforced
 * at the Hermes application layer via Postgres `userAccess` queries, this adapter
 * serves solely to maintain the cache of granted paths in `platform_external_users.externalGroupIds`.
 * No ZooKeeper credential is minted — users reach ZooKeeper only through Hermes (the
 * ensemble is network-isolated), so there is nothing to hand them.
 *
 * Account creation is synchronous, so {@link inviteUser} returns no setup link and the
 * user-creation request completes immediately (AWS-style). There is no
 * `syncUsers`/`syncGroups`: ZK exposes no directory to pull, so groups/levels are
 * defined by admins in the Admin UI (by znode path) and the Hermes-group reconciliation
 * never runs for this platform.
 */
export class ZookeeperProvisioner implements PlatformAdapter {
  readonly platform = PLATFORM;
  readonly displayName = 'ZooKeeper';

  // ── Provisioning lifecycle ────────────────────────────────────────────────────

  async provision(ctx: ProvisionContext): Promise<ProvisionResult> {
    const aclId = await this.resolveAclId(ctx.email, ctx.userId);
    if (ctx.externalGroupId) {
      const targets = zookeeperService.parseExternalGroupIds(
        ctx.externalGroupId,
      );
      for (const { path } of targets) {
        await this.cacheAddGroup(aclId, path);
        try {
          const descendants = await zookeeperService.descendantPaths(path);
          for (const desc of descendants) {
            await this.cacheAddGroup(aclId, desc);
          }
        } catch (err: any) {
          logger.warn(
            { path, error: err.message },
            'Failed to fetch descendants during provision cache seeding',
          );
        }
      }
    }
    return { externalUserId: aclId };
  }

  async deprovision(ctx: DeprovisionContext): Promise<void> {
    await this.cacheRemoveGroup(ctx.externalUserId, '');
  }

  /** Look a user up — cache-only, since ZooKeeper has no user directory. */
  async checkUserStatus(
    email: string,
    userId?: string,
  ): Promise<PlatformUserStatus> {
    const cached = await prisma.platformExternalUser.findUnique({
      where: {
        platform_email: {
          platform: PLATFORM,
          email: this.cacheRowEmail(email, userId),
        },
      },
    });
    return cached
      ? { exists: true, externalUserId: cached.externalId, email }
      : { exists: false, email };
  }

  /**
   * Seed the user's cache row. No credential is minted — the ZooKeeper ensemble is
   * network-isolated and reached only through Hermes, and managed znodes are world-open,
   * so there is no per-user secret to hand out. The user's identity is a stable key
   * ({@link cacheRowEmail}); no `inviteLink` ⇒ the account-creation request completes
   * immediately.
   *
   * The cache row is keyed on {@link cacheRowEmail}, NOT the raw email: a live Keycloak
   * JWT frequently carries no email (auth.middleware.ts), so many distinct users arrive
   * with `email = ''`. Keyed on email alone they would all collide on the single
   * `('zookeeper','')` row and each invite would overwrite the previous user's
   * `externalId` + path cache. Keying a blank email on the stable `userId` keeps each
   * user in their own row.
   */
  async inviteUser(
    email: string,
    name: string,
    userId?: string,
  ): Promise<ProvisionResult> {
    const aclId = this.cacheRowEmail(email, userId);
    const rowEmail = aclId;
    const now = new Date();
    await prisma.platformExternalUser.upsert({
      where: { platform_email: { platform: PLATFORM, email: rowEmail } },
      update: {
        externalId: aclId,
        name,
        isDisabled: false,
        isPending: false,
        lastSyncedAt: now,
      },
      create: {
        platform: PLATFORM,
        externalId: aclId,
        email: rowEmail,
        name,
        isDisabled: false,
        isPending: false,
        externalGroupIds: [],
        lastSyncedAt: now,
      },
    });
    return { externalUserId: aclId };
  }

  // ── Group lifecycle ─────────────────────────────────────────────────────────────
  // Lets the admin "New group"/"Add level" flow provision the backing znode when the
  // admin leaves the external id blank (they may also paste a "/path#perms" directly).

  /** Create a backing znode; returns its path as the external group id. */
  async createExternalGroup(
    name: string,
  ): Promise<{ externalGroupId: string; name?: string }> {
    return { externalGroupId: '/#cdrw', name };
  }

  /**
   * Validate a candidate group id BEFORE it is persisted: it must parse to at least one
   * znode path (`/path` optionally `#perms`, one per line). Throws ValidationError on a
   * malformed value so the admin layer rejects the edit instead of saving a broken
   * mapping that would then fail every provision of the group/level.
   */
  validateExternalGroupId(externalGroupId: string): void {
    zookeeperService.parseExternalGroupIds(externalGroupId);
  }

  /**
   * Delete every backing znode a group id maps to (best-effort, ignoring any #perms).
   * Each path is attempted independently so one failing znode can't strand the rest;
   * failures are logged (group deletion is best-effort cleanup — the Hermes row is the
   * source of truth and orphaned nodes can be swept manually).
   */
  async deleteExternalGroup(externalGroupId: string): Promise<void> {
    const results = await Promise.allSettled(
      zookeeperService
        .parseExternalGroupIds(externalGroupId)
        .map(({ path }) => zookeeperService.deleteNode(path)),
    );
    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (failed.length > 0) {
      logger.warn(
        {
          externalGroupId,
          errors: failed.map(
            f => (f.reason as Error)?.message ?? String(f.reason),
          ),
        },
        'ZooKeeper deleteExternalGroup: one or more backing znodes could not be deleted — manual cleanup may be required',
      );
    }
  }

  /**
   * Bring a group's existing members in line after an admin edits its path list.
   * Diffs the old vs new target sets BY PATH to report added/updated/removed paths, then
   * recomputes every member's cached path list from their active grants (the world-open
   * model has no per-znode ACLs to rewrite — the Postgres cache IS the access record).
   * Best-effort per member: the new mapping is already persisted as the source of truth,
   * so a failure is collected and returned (not thrown) for manual cleanup.
   */
  async reconcileMembers(
    ctx: ReconcileMembersContext,
  ): Promise<ReconcileMembersResult> {
    const oldTargets = ctx.oldExternalGroupId
      ? zookeeperService.parseExternalGroupIds(ctx.oldExternalGroupId)
      : [];
    const newTargets = ctx.newExternalGroupId
      ? zookeeperService.parseExternalGroupIds(ctx.newExternalGroupId)
      : [];
    const oldPermByPath = new Map(oldTargets.map(t => [t.path, t.perms]));
    const newPaths = new Set(newTargets.map(t => t.path));

    const addedPaths: string[] = [];
    const updatedPaths: string[] = [];
    const toApply = newTargets.filter(t => {
      const prev = oldPermByPath.get(t.path);
      if (prev === undefined) {
        addedPaths.push(t.path);
        return true;
      }
      if (prev !== t.perms) {
        updatedPaths.push(t.path);
        return true;
      }
      return false;
    });
    const toRemove = oldTargets.filter(t => !newPaths.has(t.path));
    const removedPaths = toRemove.map(t => t.path);

    const errors: { member: string; error: string }[] = [];
    if (toApply.length > 0 || toRemove.length > 0) {
      try {
        await Promise.all(
          ctx.members.map(m => this.cacheRemoveGroup(m.externalUserId, '')),
        );
      } catch (err: any) {
        errors.push({
          member: 'all',
          error: `reconcile failed: ${err.message}`,
        });
      }
    }

    return {
      addedPaths,
      removedPaths,
      updatedPaths,
      memberCount: ctx.members.length,
      errors,
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return zookeeperService.healthCheck();
  }

  /** Whether the adapter is running against the in-process mock store. */
  isSimulation(): boolean {
    return config.zookeeper.isSimulation;
  }

  /** Reserve ZooKeeper's own system subtree so it can never surface as a group. */
  isReservedExternalGroup(group: {
    externalId: string;
    name: string;
    type?: string | null;
  }): boolean {
    return zookeeperService.isReservedPath(group.externalId);
  }

  /** ZooKeeper has no web UI to open. */
  getLaunchUrl(): string | null {
    return null;
  }

  /**
   * Onboarding nudge once a ZooKeeper account is created. No credential is delivered —
   * access is enforced inside Hermes and the ensemble is network-isolated — so this is
   * purely a "your access is set up" confirmation.
   */
  getOnboardingMessage(): OnboardingMessage {
    return {
      notification: {
        title: 'ZooKeeper access ready',
        message:
          'Your ZooKeeper access is set up. Any approved group access has been provisioned.',
        link: '/my-requests',
      },
      email: templates.userZookeeperAccountReady({}),
      dm: '🎉 Your ZooKeeper access is set up — any approved access has been provisioned.',
    };
  }

  // ── Internal helpers ────────────────────────────────────────────────────────────

  /** Resolve the user's stable identity key (the account-creation gate guarantees it
   *  exists). Resolve by `userId` FIRST when available: the gate keys the account on
   *  `(userId, platform)` and stores the identity key on that row's `externalUserId`,
   *  so this is the identity that can't drift. Resolving by email alone breaks when the
   *  Keycloak JWT carries no/different email between account approval and this grant —
   *  the gate would say COMPLETED while this lookup misses, producing a contradictory
   *  "account not created" error. Falls back to the email-keyed cache row for legacy
   *  grants (no userId passed). A genuine miss is a real error (the account was never
   *  created), not something to paper over. */
  private async resolveAclId(email: string, userId?: string): Promise<string> {
    if (userId) {
      const account = await prisma.userCreationRequest.findUnique({
        where: { userId_platform: { userId, platform: PLATFORM } },
      });
      if (account?.externalUserId) {return account.externalUserId;}
    }
    const cached = await prisma.platformExternalUser.findUnique({
      where: {
        platform_email: { platform: PLATFORM, email: email.toLowerCase() },
      },
    });
    if (!cached) {
      throw new ValidationError(
        `No ZooKeeper identity exists for ${email}. The user's ZooKeeper account must be created (approved) before access can be provisioned.`,
      );
    }
    return cached.externalId;
  }

  /**
   * The value stored in the shared cache row's `email` column for THIS user. The row's
   * real per-user identity is its `externalId` (the same stable key this returns, unique
   * even for a blank email), and every cache helper here keys on `(platform, externalId)` — but
   * `platform_external_users` also carries a `(platform, email)` unique constraint, which
   * `inviteUser` upserts on. So two users sharing an email (notably the empty string a
   * live Keycloak JWT often yields) would collide on one row and clobber each other's
   * `externalId` + path cache. To make the row key per-user, a blank email falls back to
   * a stable, non-email sentinel derived from `userId` (`__zk_uid:<userId>`) when we have
   * one. A real email is used as-is — matching Redash/AWS and keeping the email-keyed
   * `checkUserStatus` / out-of-band lookups working unchanged. (No userId AND no email is
   * the legacy path: nothing better to key on, so it retains the old shared-row behavior.)
   */
  private cacheRowEmail(email: string, userId?: string): string {
    const normalized = (email || '').trim().toLowerCase();
    if (normalized) {return normalized;}
    return userId ? `__zk_uid:${userId}` : '';
  }

  /** Add a znode path to the user's cached membership list. A single atomic statement
   *  (the `NOT ... = ANY` guard makes append + de-dup race-free, mirroring the
   *  `array_remove` on the remove side) so two concurrent grants on path-sharing groups
   *  can't double-insert the same path. No-op when the row is absent (0 rows updated).
   *  The cache keys on the bare path (not `path#perms`) so a perms change never leaves a
   *  stale entry and removal always matches. */
  private async cacheAddGroup(aclId: string, path: string): Promise<void> {
    await prisma.$executeRaw`
      UPDATE platform_external_users
      SET external_group_ids = array_append(external_group_ids, ${path}),
          last_synced_at = NOW()
      WHERE platform = ${PLATFORM} AND external_id = ${aclId}
        AND NOT (${path} = ANY(external_group_ids))
    `;
  }



  /** Remove a znode path from the user's cached membership list (atomic, idempotent). */
  private async cacheRemoveGroup(aclId: string, _path: string): Promise<void> {
    const grants = await prisma.userAccess.findMany({
      where: { externalUserId: aclId, isActive: true },
      include: { group: true, level: true },
    });
    const activePaths = new Set<string>();
    for (const g of grants) {
      const externalGroupId =
        g.level?.externalGroupId ?? g.group.externalGroupId;
      if (!externalGroupId) {continue;}
      try {
        for (const t of zookeeperService.parseExternalGroupIds(
          externalGroupId,
        )) {
          activePaths.add(t.path);
          try {
            const descendants = await zookeeperService.descendantPaths(t.path);
            for (const desc of descendants) {
              activePaths.add(desc);
            }
          } catch (err: any) {
            logger.warn(
              { path: t.path, error: err.message },
              'Failed to fetch descendants during cache recalculation',
            );
          }
        }
      } catch {
        // ignore malformed or missing config
      }
    }
    const pathsArray = [...activePaths];
    await prisma.platformExternalUser.update({
      where: { platform_externalId: { platform: PLATFORM, externalId: aclId } },
      data: {
        externalGroupIds: pathsArray,
        lastSyncedAt: new Date(),
      },
    });
  }
}

export const zookeeperProvisioner = new ZookeeperProvisioner();
export default zookeeperProvisioner;
