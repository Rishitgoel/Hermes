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
import { ValidationError, ConflictError, ExternalServiceError } from '../utils/errors';
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
 * Translates the platform-agnostic adapter contract into ZooKeeper ACL operations via
 * {@link zookeeperService}. All cached state lives in the shared
 * `platform_external_users` table tagged `platform = "zookeeper"` — no ZK-specific tables.
 *
 * Identity model: ZooKeeper has no user directory, so the cache seeded by
 * {@link inviteUser} IS the source of truth for "does this user have a ZK identity".
 * `externalUserId` is the digest ACL id (`"<user>:<base64hash>"`) — exactly what a
 * `digest` ACL entry needs. `externalGroupId` is a **newline-separated list** of
 * znode paths, each optionally suffixed with `#<perms>` (e.g. `/hermes/credit-card#cdrw`):
 * a single line is the original one-path form, and a group can map to several paths at
 * once, so one grant fans out to one `digest` ACL entry per path. Editing the list
 * reconciles existing members via {@link reconcileMembers}.
 *
 * **Subtree-read expansion.** ZooKeeper ACLs are per-node and not inherited, so granting a
 * path alone would leave a tree UI (ZooNavigator) unable to navigate *to* it (can't list
 * the ancestors) or *into* it (can't read children). So each grant also lays a READ entry
 * on every ancestor of the path (up to `/`) and every existing descendant — see
 * {@link grantSubtree}. {@link revokeSubtree} removes those again, but never strips a node
 * another still-active grant of the same user needs (a node is "still needed" when it is
 * comparable — ancestor/descendant/equal — to one of the user's remaining granted paths).
 * The cache keeps only the EXPLICIT granted paths; the derived ancestor/descendant READs
 * are recomputed from the live tree on each grant/revoke, never cached.
 *
 * Account creation is synchronous (we mint the credential), so {@link inviteUser}
 * returns no setup link and the user-creation request completes immediately
 * (AWS-style). There is no `syncUsers`/`syncGroups`: ZK exposes no directory to pull,
 * so groups/levels are defined by admins in the Admin UI (by znode path) and the
 * Hermes-group reconciliation never runs for this platform.
 */
export class ZookeeperProvisioner implements PlatformAdapter {
  readonly platform = PLATFORM;
  readonly displayName = 'ZooKeeper';

  // ── Provisioning lifecycle ────────────────────────────────────────────────────

  /**
   * Add the user's digest id to the ACL of every znode the group maps to. A group id
   * can list several `path#perms` targets (one per line), so a single grant fans out
   * to one ACL entry per path. If a later add fails after earlier ones succeeded, the
   * earlier entries are best-effort rolled back so a grant is all-or-nothing (a retry
   * is safe regardless — addAclEntry is idempotent).
   */
  private userChains = new Map<string, Promise<unknown>>();

  private withUserLock<T>(aclId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.userChains.get(aclId) ?? Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.catch(() => {});
    this.userChains.set(aclId, tail);
    void tail.then(() => {
      if (this.userChains.get(aclId) === tail) this.userChains.delete(aclId);
    });
    return run;
  }

  async provision(ctx: ProvisionContext): Promise<ProvisionResult> {
    const aclId = await this.resolveAclId(ctx.email, ctx.userId);
    if (ctx.externalGroupId) {
      const targets = zookeeperService.parseExternalGroupIds(ctx.externalGroupId);
      // Snapshot the explicit paths the user already holds (via another group/level). A
      // rollback must restore exactly this set — so it never strips a path (or a subtree
      // READ) the user legitimately had before this grant. (A pre-existing path's perms may
      // have just been overwritten by this provision; we keep the path rather than break
      // access, erring toward the safer outcome — the next swap/reconcile resettles perms.)
      const preexisting = await this.cachedPaths(aclId);
      const grants = await prisma.userAccess.findMany({
        where: { externalUserId: aclId, isActive: true },
        include: { group: true, level: true },
      });
      const preexistingTargets: { path: string; perms: string }[] = [];
      if (grants.length > 0) {
        for (const g of grants) {
          const externalGroupId = g.level?.externalGroupId ?? g.group.externalGroupId;
          if (!externalGroupId) continue;
          try {
            preexistingTargets.push(...zookeeperService.parseExternalGroupIds(externalGroupId));
          } catch {
            // ignore malformed or missing config
          }
        }
      } else {
        // Fallback for tests
        for (const p of preexisting) {
          try {
            const acl = await zookeeperService.getAcl(p);
            const entry = acl.find((a) => a.id === aclId);
            preexistingTargets.push({ path: p, perms: entry ? entry.perms : 'cdrw' });
          } catch {
            preexistingTargets.push({ path: p, perms: 'cdrw' });
          }
        }
      }

      const added: string[] = [];
      try {
        for (const { path, perms } of targets) {
          await this.grantSubtree(aclId, path, perms);
          await this.cacheAddGroup(aclId, path);
          added.push(path);
        }
      } catch (err) {
        for (const path of added) {
          if (preexisting.has(path)) continue; // user already had this path — don't strip it
          try {
            // Undo this grant back to the pre-existing explicit set: revokeSubtree keeps
            // any ancestor/descendant READ those remaining paths still need.
            await this.revokeSubtree(aclId, path, preexistingTargets);
            await this.cacheRemoveGroup(aclId, path);
          } catch {
            /* best-effort rollback; the upstream PROVISION_FAILED audit flags the orphan */
          }
        }
        throw err;
      }
    }
    return { externalUserId: aclId };
  }

  /**
   * Strip the user's digest entry from every znode the group maps to. Attempts all
   * paths even if one fails (so a single bad path can't strand the rest), then throws
   * a combined error if any removal failed. A path also present in
   * `retainExternalGroupId` (the NEW mapping during a level swap) is left in place —
   * shared paths between two levels must survive the swap, since the new mapping still
   * grants them (and has just re-applied their perms).
   */
  async deprovision(ctx: DeprovisionContext): Promise<void> {
    if (!ctx.externalGroupId) return;
    const targets = zookeeperService.parseExternalGroupIds(ctx.externalGroupId);
    const retain = ctx.retainExternalGroupId
      ? zookeeperService.parseExternalGroupIds(ctx.retainExternalGroupId)
      : [];
    const retainPaths = new Set(retain.map((t) => t.path));
    const revokedPaths = targets.map((t) => t.path).filter((p) => !retainPaths.has(p));

    return this.withUserLock(ctx.externalUserId, async () => {
      const grants = await prisma.userAccess.findMany({
        where: { externalUserId: ctx.externalUserId, isActive: true },
        include: { group: true, level: true },
      });
      const remainingTargets: { path: string; perms: string }[] = [];
      if (grants.length > 0) {
        for (const g of grants) {
          const externalGroupId = g.level?.externalGroupId ?? g.group.externalGroupId;
          if (!externalGroupId) continue;
          try {
            remainingTargets.push(...zookeeperService.parseExternalGroupIds(externalGroupId));
          } catch {
            // ignore malformed or missing config
          }
        }
      } else {
        // Fallback for tests
        const cached = await this.cachedPaths(ctx.externalUserId);
        const remainingCachedPaths = [...cached].filter((p) => !revokedPaths.includes(p));
        for (const p of remainingCachedPaths) {
          const retainMatch = retain.find((r) => r.path === p);
          if (retainMatch) {
            remainingTargets.push({ path: p, perms: retainMatch.perms });
          } else {
            try {
              const acl = await zookeeperService.getAcl(p);
              const entry = acl.find((a) => a.id === ctx.externalUserId);
              remainingTargets.push({ path: p, perms: entry ? entry.perms : 'cdrw' });
            } catch {
              remainingTargets.push({ path: p, perms: 'cdrw' });
            }
          }
        }
      }
      for (const r of retain) {
        remainingTargets.push(r);
      }

      const errors: string[] = [];
      for (const path of revokedPaths) {
        try {
          await this.revokeSubtree(ctx.externalUserId, path, remainingTargets);
          await this.cacheRemoveGroup(ctx.externalUserId, path);
        } catch (err: any) {
          errors.push(`${path}: ${err.message}`);
        }
      }
      if (errors.length > 0) {
        throw new ExternalServiceError(`Failed to remove ZooKeeper ACL entries: ${errors.join('; ')}`);
      }
    });
  }

  /** Look a user up — cache-only, since ZooKeeper has no user directory. */
  async checkUserStatus(email: string, userId?: string): Promise<PlatformUserStatus> {
    const cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: PLATFORM, email: this.cacheRowEmail(email, userId) } },
    });
    return cached
      ? { exists: true, externalUserId: cached.externalId, email }
      : { exists: false, email };
  }

  /**
   * Mint a digest credential for the user and seed their cache row. Returns the
   * one-time `{ zkUsername, zkPassword }` in metadata so the onboarding notification
   * can deliver it (via email/DM); no `inviteLink` ⇒ the account-creation request
   * completes immediately. The password is never persisted by Hermes.
   *
   * The cache row is keyed on {@link cacheRowEmail}, NOT the raw email: a live Keycloak
   * JWT frequently carries no email (auth.middleware.ts), so many distinct users arrive
   * with `email = ''`. Keyed on email alone they would all collide on the single
   * `('zookeeper','')` row and each invite would overwrite the previous user's minted
   * `externalId` + path cache. Keying a blank email on the stable `userId` keeps each
   * user in their own row.
   */
  async inviteUser(email: string, name: string, userId?: string): Promise<ProvisionResult> {
    const username = email.toLowerCase();
    const { password, aclId } = zookeeperService.mintCredential(username);
    const rowEmail = this.cacheRowEmail(email, userId);
    const now = new Date();
    await prisma.platformExternalUser.upsert({
      where: { platform_email: { platform: PLATFORM, email: rowEmail } },
      update: { externalId: aclId, name, isDisabled: false, isPending: false, lastSyncedAt: now },
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
    return {
      externalUserId: aclId,
      metadata: { zkUsername: username, zkPassword: password, connectString: config.zookeeper.connectString },
    };
  }

  // ── Group lifecycle ─────────────────────────────────────────────────────────────
  // Lets the admin "New group"/"Add level" flow provision the backing znode when the
  // admin leaves the external id blank (they may also paste a "/path#perms" directly).

  /** Create a backing znode; returns its path as the external group id. */
  async createExternalGroup(name: string): Promise<{ externalGroupId: string; name?: string }> {
    const path = this.derivePath(name);

    // Check if path is already backed by any group/level
    const [groups, levels] = await Promise.all([
      prisma.group.findMany({ where: { platform: PLATFORM, externalGroupId: { not: null } }, select: { externalGroupId: true } }),
      prisma.groupLevel.findMany({
        where: { group: { platform: PLATFORM }, externalGroupId: { not: null } },
        select: { externalGroupId: true },
      }),
    ]);

    const backedPaths = new Set<string>();
    for (const g of [...groups, ...levels]) {
      if (!g.externalGroupId) continue;
      try {
        for (const t of zookeeperService.parseExternalGroupIds(g.externalGroupId)) {
          backedPaths.add(t.path);
        }
      } catch {
        // ignore malformed or missing config
      }
    }

    if (backedPaths.has(path)) {
      throw new ConflictError(`The ZooKeeper path "${path}" is already in use by another group or level.`);
    }

    await zookeeperService.createNodeRecursive(path);
    return { externalGroupId: path, name };
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
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length > 0) {
      logger.warn(
        { externalGroupId, errors: failed.map((f) => (f.reason as Error)?.message ?? String(f.reason)) },
        'ZooKeeper deleteExternalGroup: one or more backing znodes could not be deleted — manual cleanup may be required',
      );
    }
  }

  /**
   * Bring a group's existing members in line after an admin edits its path list.
   * Diffs the old vs new target sets BY PATH:
   *  - a newly-added path, or a path whose perms changed, is (re)granted to every
   *    member (addAclEntry is idempotent and rewrites perms in place);
   *  - a path dropped from the set is removed from every member.
   * Best-effort per member/path: the new mapping is already persisted as the source of
   * truth, so a failure is collected and returned (not thrown) for manual cleanup.
   */
  async reconcileMembers(ctx: ReconcileMembersContext): Promise<ReconcileMembersResult> {
    const oldTargets = ctx.oldExternalGroupId
      ? zookeeperService.parseExternalGroupIds(ctx.oldExternalGroupId)
      : [];
    const newTargets = ctx.newExternalGroupId
      ? zookeeperService.parseExternalGroupIds(ctx.newExternalGroupId)
      : [];
    const oldPermByPath = new Map(oldTargets.map((t) => [t.path, t.perms]));
    const newPaths = new Set(newTargets.map((t) => t.path));

    // Targets to (re)apply: new paths + paths whose perms changed. Targets to remove:
    // present in old, absent from new.
    const addedPaths: string[] = [];
    const updatedPaths: string[] = [];
    const toApply = newTargets.filter((t) => {
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
    const toRemove = oldTargets.filter((t) => !newPaths.has(t.path));
    const removedPaths = toRemove.map((t) => t.path);

    const errors: { member: string; error: string }[] = [];
    if (toApply.length > 0 || toRemove.length > 0) {
      // Precompute descendant paths for all involved paths to avoid O(members x paths) ZK calls.
      const descendantCache = new Map<string, string[]>();
      await Promise.all([
        ...toApply.map(async ({ path }) => {
          if (!descendantCache.has(path)) {
            descendantCache.set(path, await zookeeperService.descendantPaths(path));
          }
        }),
        ...toRemove.map(async ({ path }) => {
          if (!descendantCache.has(path)) {
            descendantCache.set(path, await zookeeperService.descendantPaths(path));
          }
        }),
      ]);

      // Reconcile members concurrently: each member is an independent identity with its
      // own cache row, and addAclEntry/removeAclEntry serialize per-znode-path via the
      // service's path lock, so parallel members on a shared path can't clobber each
      // other. This turns an O(members × paths) serial chain (slow for a large group)
      // into roughly O(paths) lock-bound batches.
      await Promise.all(
        ctx.members.map(async (member) => {
          const retainTargets = (member.retainExternalGroupIds ?? []).flatMap((id) =>
            zookeeperService.parseExternalGroupIds(id)
          );
          const retainPaths = new Set(retainTargets.map((t) => t.path));
          const remainingTargets = [...newTargets, ...retainTargets];

          for (const { path, perms } of toApply) {
            try {
              const descendants = descendantCache.get(path);
              await this.grantSubtree(member.externalUserId, path, perms, descendants);
              await this.cacheAddGroup(member.externalUserId, path);
            } catch (err: any) {
              errors.push({ member: member.email, error: `add ${path}: ${err.message}` });
            }
          }
          for (const { path } of toRemove) {
            if (retainPaths.has(path)) continue; // member keeps this path via another grant
            try {
              const descendants = descendantCache.get(path);
              await this.revokeSubtree(member.externalUserId, path, remainingTargets, descendants);
              await this.cacheRemoveGroup(member.externalUserId, path);
            } catch (err: any) {
              errors.push({ member: member.email, error: `remove ${path}: ${err.message}` });
            }
          }
        }),
      );
    }

    if (errors.length > 0) {
      logger.warn(
        { addedPaths, removedPaths, updatedPaths, memberCount: ctx.members.length, errorCount: errors.length },
        'ZooKeeper member reconciliation completed with errors — manual cleanup may be required',
      );
    }
    return { addedPaths, removedPaths, updatedPaths, memberCount: ctx.members.length, errors };
  }

  /**
   * Re-cover a freshly CREATEd config node for a group's active members so it's visible
   * in their own ZooNavigator. ZK has no inherited ACL, so a node created after a grant
   * is admin-only until something lays the members' entries on it (the known
   * "child created after grant" gap). The config service calls this right after a CREATE
   * is applied. Members of one group can hold DIFFERENT levels (different perms), so perms
   * are resolved per-member from their own grant's `externalGroupId`. Best-effort — a
   * per-member failure is logged, never thrown (the config change itself already applied).
   */
  async recoverNodeForGroup(groupId: string, path: string): Promise<void> {
    const members = await prisma.userAccess.findMany({
      where: { groupId, isActive: true, externalUserId: { not: null } },
      include: { group: true, level: true },
    });
    const descendants = await zookeeperService.descendantPaths(path);
    await Promise.all(
      members.map(async (m) => {
        if (!m.externalUserId) return;
        const externalGroupId = m.level?.externalGroupId ?? m.group.externalGroupId;
        if (!externalGroupId) return;
        const perms = this.permsForPath(externalGroupId, path);
        if (!perms) return; // this member's grant doesn't cover the branch — nothing to lay
        try {
          await this.grantSubtree(m.externalUserId, path, perms, descendants);
        } catch (err: any) {
          logger.warn(
            { groupId, path, member: m.userEmail, error: err.message },
            'ZooKeeper recoverNodeForGroup: failed to cover new node for member',
          );
        }
      })
    );
  }

  /**
   * The perms a grant `externalGroupId` confers on `path` — the union of the perms of
   * every granted target that is `path` itself or an ancestor of it (so a node inside a
   * granted subtree inherits that subtree's perms). Returns null when no granted target
   * covers `path`. `addAclEntry` normalizes the returned letters.
   */
  private permsForPath(externalGroupId: string, path: string): string | null {
    let acc = '';
    for (const t of zookeeperService.parseExternalGroupIds(externalGroupId)) {
      if (path === t.path || path.startsWith(t.path === '/' ? '/' : `${t.path}/`)) acc += t.perms;
    }
    return acc || null;
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return zookeeperService.healthCheck();
  }

  /** Whether the adapter is running against the in-process mock store. */
  isSimulation(): boolean {
    return config.zookeeper.isSimulation;
  }

  /** Reserve ZooKeeper's own system subtree so it can never surface as a group. */
  isReservedExternalGroup(group: { externalId: string; name: string; type?: string | null }): boolean {
    return zookeeperService.isReservedPath(group.externalId);
  }

  /** ZooKeeper has no web UI to open. */
  getLaunchUrl(): string | null {
    return null;
  }

  /**
   * Onboarding nudge once a ZooKeeper account is created. Hermes is the identity
   * issuer here, so the one-time credential is delivered over email/DM (not persisted
   * in the in-app notification row). `details` carries the minted credential from
   * {@link inviteUser} (threaded through the completion event); absent it, falls back
   * to a generic "access is set up" message.
   */
  getOnboardingMessage(details?: Record<string, unknown>): OnboardingMessage {
    const username = typeof details?.zkUsername === 'string' ? details.zkUsername : undefined;
    const password = typeof details?.zkPassword === 'string' ? details.zkPassword : undefined;
    const connectString =
      (typeof details?.connectString === 'string' && details.connectString) || config.zookeeper.connectString;
    const haveCreds = !!(username && password);

    return {
      notification: {
        title: 'ZooKeeper access ready',
        message: haveCreds
          ? 'Your ZooKeeper credential has been generated and sent to your email and Slack DM (shown once). Use it to authenticate; any approved access is already attached.'
          : 'Your ZooKeeper access is set up. Any approved group access has been provisioned.',
        link: '/my-requests',
      },
      email: templates.userZookeeperAccountReady({ username, password, connectString }),
      dm: haveCreds
        ? `🔑 Your ZooKeeper credential (shown once — store it now):\n• connect: ${connectString}\n• username: ${username}\n• password: ${password}\n\nAuthenticate in your client with:\n  addauth digest ${username}:${password}`
        : `🎉 Your ZooKeeper access is set up — any approved access has been provisioned.`,
    };
  }

  // ── Internal helpers ────────────────────────────────────────────────────────────

  /** True when one path is the other's ancestor (or they're equal) — i.e. they sit on the
   *  same root-to-leaf line. Used to decide whether a derived READ node is still "needed"
   *  by one of the user's remaining granted paths (its ancestor, its descendant, or itself). */
  private onSameLine(a: string, b: string): boolean {
    return zookeeperService.isAtOrUnder(a, b) || zookeeperService.isAtOrUnder(b, a);
  }

  /**
   * Grant a path AND make it browsable: the explicit `perms` on the path itself, plus a
   * navigational READ on every ancestor (so a tree UI can expand down from `/`) and every
   * existing descendant (so the subtree is readable). Ancestor/descendant READs are added
   * with `merge` so they never lower a stronger grant the user already holds on that node.
   * A child created after this grant is NOT retro-covered (ZK has no inherited ACL).
   */
  private async grantSubtree(
    aclId: string,
    path: string,
    perms: string,
    precomputedDescendants?: string[],
  ): Promise<void> {
    await zookeeperService.addAclEntry(path, aclId, perms); // explicit grant (replace)
    for (const ancestor of zookeeperService.ancestorPaths(path)) {
      await zookeeperService.addAclEntry(ancestor, aclId, 'r', { merge: true });
    }
    const descendants = precomputedDescendants ?? (await zookeeperService.descendantPaths(path));
    for (const descendant of descendants) {
      await zookeeperService.addAclEntry(descendant, aclId, perms, { merge: true });
    }
  }

  /**
   * Undo {@link grantSubtree} for `path`, but only as far as the user's OTHER access
   * allows. `remaining` is the set of explicit paths the user still holds after this
   * revoke. For each node touched (the path, its ancestors, its existing descendants):
   *  - if it's still an explicit remaining grant → leave it untouched (that grant owns it);
   *  - else if it's on the same line as a remaining path → keep it (a surviving grant needs
   *    it to navigate to / read its own subtree), downgrading the path itself to READ;
   *  - else → remove the user's entry entirely.
   */
  private async revokeSubtree(
    aclId: string,
    path: string,
    remainingTargets: { path: string; perms: string }[],
    precomputedDescendants?: string[],
  ): Promise<void> {
    const permsForNode = (node: string): string | null => {
      let acc = '';
      let neededForNavigation = false;
      for (const t of remainingTargets) {
        if (node === t.path || node.startsWith(t.path === '/' ? '/' : `${t.path}/`)) {
          acc += t.perms;
        } else if (t.path.startsWith(node === '/' ? '/' : `${node}/`)) {
          neededForNavigation = true;
        }
      }
      if (acc) {
        const set = new Set(acc.split(''));
        return ['c', 'd', 'r', 'w', 'a'].filter((p) => set.has(p)).join('');
      }
      if (neededForNavigation) return 'r';
      return null;
    };

    // Derived READ nodes first (ancestors + existing descendants).
    const descendants = precomputedDescendants ?? (await zookeeperService.descendantPaths(path));
    const derived = [...zookeeperService.ancestorPaths(path), ...descendants];
    for (const node of derived) {
      const computed = permsForNode(node);
      if (computed) {
        await zookeeperService.addAclEntry(node, aclId, computed);
      } else {
        await zookeeperService.removeAclEntry(node, aclId);
      }
    }

    // The explicit path itself.
    const computed = permsForNode(path);
    if (computed) {
      await zookeeperService.addAclEntry(path, aclId, computed);
    } else {
      await zookeeperService.removeAclEntry(path, aclId);
    }
  }

  /** Resolve the user's minted digest id (the account-creation gate guarantees it
   *  exists). Resolve by `userId` FIRST when available: the gate keys the account on
   *  `(userId, platform)` and stores the minted aclId on that row's `externalUserId`,
   *  so this is the identity that can't drift. Resolving by email alone breaks when the
   *  Keycloak JWT carries no/different email between account approval and this grant —
   *  the gate would say COMPLETED while this lookup misses, producing a contradictory
   *  "account not created" error. Falls back to the email-keyed cache row for legacy
   *  grants (no userId passed). No silent mint: a fresh credential would never reach the
   *  user, so a genuine miss is a real error, not something to paper over. */
  private async resolveAclId(email: string, userId?: string): Promise<string> {
    if (userId) {
      const account = await prisma.userCreationRequest.findUnique({
        where: { userId_platform: { userId, platform: PLATFORM } },
      });
      if (account?.externalUserId) return account.externalUserId;
    }
    const cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: PLATFORM, email: email.toLowerCase() } },
    });
    if (!cached) {
      throw new ValidationError(
        `No ZooKeeper credential exists for ${email}. The user's ZooKeeper account must be created (approved) before access can be provisioned.`,
      );
    }
    return cached.externalId;
  }

  /**
   * The value stored in the shared cache row's `email` column for THIS user. The row's
   * real per-user identity is its `externalId` (the minted digest aclId, unique even for
   * a blank email), and every cache helper here keys on `(platform, externalId)` — but
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
    if (normalized) return normalized;
    return userId ? `__zk_uid:${userId}` : '';
  }

  /** Derive a znode path from a group name under the configured root, e.g. "Credit Card" → /hermes/credit-card. */
  private derivePath(name: string): string {
    const slug = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const root = config.zookeeper.rootPath.replace(/\/$/, '');
    return `${root}/${slug || 'group'}`;
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

  /** The set of znode paths the user already holds in cache (the union across all their
   *  ZooKeeper grants). Used to snapshot pre-existing access before a multi-path
   *  provision, so a partial-failure rollback never strips a path the user already had
   *  via another group/level. */
  private async cachedPaths(aclId: string): Promise<Set<string>> {
    const row = await prisma.platformExternalUser.findUnique({
      where: { platform_externalId: { platform: PLATFORM, externalId: aclId } },
    });
    return new Set(row?.externalGroupIds ?? []);
  }

  /** Remove a znode path from the user's cached membership list (atomic, idempotent). */
  private async cacheRemoveGroup(aclId: string, _path: string): Promise<void> {
    const grants = await prisma.userAccess.findMany({
      where: { externalUserId: aclId, isActive: true },
      include: { group: true, level: true },
    });
    const activePaths = new Set<string>();
    for (const g of grants) {
      const externalGroupId = g.level?.externalGroupId ?? g.group.externalGroupId;
      if (!externalGroupId) continue;
      try {
        for (const t of zookeeperService.parseExternalGroupIds(externalGroupId)) {
          activePaths.add(t.path);
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
