import provisioningRegistry from './provisioning.registry';
import { PlatformAdapter } from './provisioner.interface';
import prisma from '../config/prisma';
import config from '../config/config';
import logger from '../utils/logger';

/**
 * Don't archive a Hermes group (or deactivate a level) created within this
 * window. The platform cache is eventually consistent — a backing group created
 * moments ago via `adapter.createExternalGroup` may not have surfaced in the
 * platform's ListGroups yet, so its cache row doesn't exist and the group would
 * look orphaned. Same 10-minute grace the adapters use for cache pruning.
 */
const RECONCILE_GRACE_MS = 10 * 60 * 1000;

/**
 * Platform-agnostic sync orchestrator.
 *
 * Owns no platform-specific logic — it walks every adapter registered in the
 * {@link provisioningRegistry} and asks each one to refresh its own cache via
 * the optional `syncGroups()` / `syncUsers()` hooks on the adapter interface.
 * Each platform is independent: a failure syncing one platform is logged and
 * does not abort the others.
 *
 * Invoked from the hourly/periodic scheduler and from `POST /api/admin/sync`.
 */
export class SyncService {
  private lastSyncedAt: Date | null = null;

  /** Timestamp of the last successful sync of any platform (for /health). */
  getLastSyncedAt(): Date | null {
    return this.lastSyncedAt;
  }

  /** Refresh the cache for every registered platform. Each platform's sync runs
   *  concurrently — platforms are independent (different cache rows, different
   *  adapters). Per-platform failures are isolated via Promise.allSettled so one
   *  bad platform can't block or fail the rest. */
  async syncAllPlatforms(): Promise<{ usersSynced: number; groupsSynced: number }> {
    logger.info('🔄 SyncService: Starting sync across all platforms...');

    const platforms = provisioningRegistry.listPlatforms().filter((platform) => {
      const adapter = provisioningRegistry.tryGet(platform);
      if (adapter?.isEnabled && !adapter.isEnabled()) {
        logger.info(`🔄 SyncService: Skipping ${platform} sync because it is disabled.`);
        return false;
      }
      return true;
    });

    const results = await Promise.allSettled(
      platforms.map((platform) => this.syncSinglePlatform(platform)),
    );

    let usersSynced = 0;
    let groupsSynced = 0;
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        usersSynced += result.value.usersSynced;
        groupsSynced += result.value.groupsSynced;
      } else {
        logger.error(
          { platform: platforms[i], error: result.reason?.message ?? String(result.reason) },
          '🔄 SyncService: Platform sync failed',
        );
      }
    });

    this.lastSyncedAt = new Date();
    logger.info(`🔄 SyncService: Sync complete — ${usersSynced} users, ${groupsSynced} groups.`);
    return { usersSynced, groupsSynced };
  }

  /** Refresh the cache for a single platform. Groups first, then users (member counts depend on both). */
  async syncSinglePlatform(platform: string): Promise<{ usersSynced: number; groupsSynced: number }> {
    const adapter = provisioningRegistry.get(platform);
    const groups = adapter.syncGroups ? await adapter.syncGroups() : { count: 0 };
    const users = adapter.syncUsers ? await adapter.syncUsers() : { count: 0 };
    if (adapter.syncGroups) {
      try {
        await this.reconcileHermesGroups(platform, adapter);
      } catch (err: any) {
        // Reconciliation is best-effort on top of the cache sync — never fail the sync over it.
        logger.error({ platform, error: err.message }, '🔄 SyncService: Hermes-group reconciliation failed');
      }
    }
    this.lastSyncedAt = new Date();
    return { usersSynced: users.count, groupsSynced: groups.count };
  }

  /**
   * Mirror the platform's real group list into the Hermes `groups` table so what
   * users see always matches what exists on the platform:
   *
   *  - HEAL FIRST: a Hermes group/level whose stored externalGroupId no longer
   *    exists is re-linked by NAME before anything is archived — a group matches
   *    a platform group with its own name, a level matches the
   *    "<Group> — <Level>" convention used when its backing group was created
   *    (the same matching `scripts/reset-for-live-aws.ts` uses). This covers the
   *    deleted-and-recreated-with-a-new-id case: the link is repaired and the
   *    group/level reactivated, instead of the real group being archived while a
   *    duplicate (or a stray standalone group for a level's backing group)
   *    appears. A pristine group a previous sync auto-created from a level's
   *    backing group is deleted when the level reclaims it.
   *  - a platform group not yet represented in Hermes → auto-create an active
   *    Hermes group for it (unless the adapter marks it reserved — e.g. AWS's
   *    API-TESTING permission group or Redash's built-in default/admin groups).
   *    A name parsing as "<existing group> — <level>" becomes a LEVEL of that
   *    group instead of a standalone group, and a stray standalone group a
   *    previous sync created from such a name is folded back into its parent
   *    as a level (when still pristine);
   *  - an active Hermes group whose backing platform group vanished (or is
   *    reserved) → archive it (`isActive: false`) — never hard-delete, history
   *    and grants stay intact;
   *  - an active level whose backing platform group vanished → soft-deactivate it.
   *
   * Runs only when the adapter is live (`isSimulation()` false/absent) so local
   * dev seed data is never reshuffled to match the in-process mock stores, and
   * reads from the `platform_external_groups` cache the adapter just refreshed.
   * Does NOT blanket-reactivate archived groups whose link is still intact:
   * archiving is also a deliberate admin action, so only a *broken* link being
   * healed reactivates — anything else stays as the admin left it.
   */
  async reconcileHermesGroups(platform: string, adapter: PlatformAdapter): Promise<void> {
    if (adapter.isSimulation?.()) {
      logger.debug({ platform }, '🔄 SyncService: simulation mode — skipping Hermes-group reconciliation');
      return;
    }

    const cached = await prisma.platformExternalGroup.findMany({ where: { platform } });
    // An empty cache means the platform fetch returned nothing (or never ran) —
    // archiving everything on that signal would be the exact disaster this
    // feature exists to prevent. Bail out.
    if (cached.length === 0) {
      logger.warn({ platform }, '🔄 SyncService: external-group cache empty — skipping reconciliation');
      return;
    }

    const isReserved = (g: { externalId: string; name: string; type: string | null }) =>
      adapter.isReservedExternalGroup?.({ externalId: g.externalId, name: g.name, type: g.type }) ?? false;
    const cachedIds = new Set(cached.map(g => g.externalId));
    const reservedIds = new Set(cached.filter(isReserved).map(g => g.externalId));
    // Name → cache row, for healing broken links (dash/whitespace-insensitive).
    const byName = new Map<string, (typeof cached)[number]>();
    for (const g of cached) {
      if (!reservedIds.has(g.externalId)) byName.set(this.normalizeName(g.name), g);
    }

    const hermesGroups = await prisma.group.findMany({
      where: { platform },
      include: { levels: true, _count: { select: { accessRequests: true, userAccesses: true } } },
    });
    // Every external id any Hermes group or level already points at (active or
    // archived) — auto-create must not produce a duplicate mapping, and a
    // level's backing group must not surface as a standalone requestable group.
    const referencedIds = new Set<string>();
    for (const g of hermesGroups) {
      if (g.externalGroupId) referencedIds.add(g.externalGroupId);
      for (const l of g.levels) if (l.externalGroupId) referencedIds.add(l.externalGroupId);
    }

    // Groups a previous sync run auto-created (audited GROUP_CREATED by the
    // system) that are still pristine — no levels, no requests, no grants. If a
    // healed link reclaims their platform group, they are duplicates and can be
    // deleted outright.
    const syncCreatedAudits = await prisma.auditEntry.findMany({
      where: { action: 'GROUP_CREATED', performerId: 'system', groupId: { in: hermesGroups.map(g => g.id) } },
      select: { groupId: true },
    });
    const syncCreatedIds = new Set(syncCreatedAudits.map(a => a.groupId));
    const pristineSyncGroupByExtId = new Map<string, (typeof hermesGroups)[number]>();
    for (const g of hermesGroups) {
      if (
        g.externalGroupId && syncCreatedIds.has(g.id) && g.levels.length === 0
        && g._count.accessRequests === 0 && g._count.userAccesses === 0
      ) {
        pristineSyncGroupByExtId.set(g.externalGroupId, g);
      }
    }
    const deletedGroupIds = new Set<string>();

    const graceCutoff = new Date(Date.now() - RECONCILE_GRACE_MS);
    let created = 0, archived = 0, levelsDeactivated = 0;
    let relinkedGroups = 0, relinkedLevels = 0, duplicatesDeleted = 0;

    /**
     * Free `extId` so a healed group/level can claim it. Returns false if a real
     * (non-pristine, non-sync-created) group/level already owns it; deletes a
     * pristine sync-created duplicate that owns it.
     */
    const claimForRelink = async (extId: string): Promise<boolean> => {
      if (!referencedIds.has(extId)) return true;
      const dup = pristineSyncGroupByExtId.get(extId);
      if (!dup || deletedGroupIds.has(dup.id)) return false;
      await prisma.group.delete({ where: { id: dup.id } });
      deletedGroupIds.add(dup.id);
      pristineSyncGroupByExtId.delete(extId);
      referencedIds.delete(extId);
      await prisma.auditEntry.create({
        data: {
          action: 'GROUP_DELETED',
          performerId: 'system',
          performerName: 'Platform Sync',
          details: { source: 'platform-sync', platform, slug: dup.slug, externalGroupId: extId, reason: 'duplicate of a re-linked group/level' },
        },
      });
      duplicatesDeleted++;
      return true;
    };

    // ── 1. Heal levels whose backing platform group was recreated under a new id ──
    // Match by the "<Group> — <Level>" naming convention. Only a BROKEN link
    // (id missing from the platform, or never set) is healed — a level that
    // still points at a live platform group is left exactly as the admin set it.
    for (const g of hermesGroups) {
      for (const level of g.levels) {
        const linkIntact = level.externalGroupId
          && cachedIds.has(level.externalGroupId) && !reservedIds.has(level.externalGroupId);
        if (linkIntact) continue;
        const candidate = byName.get(this.normalizeName(`${g.name} — ${level.name}`));
        if (!candidate || !(await claimForRelink(candidate.externalId))) continue;
        await prisma.groupLevel.update({
          where: { id: level.id },
          data: { externalGroupId: candidate.externalId, isActive: true },
        });
        await prisma.auditEntry.create({
          data: {
            action: 'GROUP_LEVEL_UPDATED',
            performerId: 'system',
            performerName: 'Platform Sync',
            groupId: g.id,
            details: {
              source: 'platform-sync', platform, levelId: level.id, slug: level.slug,
              relinkedFrom: level.externalGroupId, relinkedTo: candidate.externalId,
            },
          },
        });
        referencedIds.add(candidate.externalId);
        level.externalGroupId = candidate.externalId;
        level.isActive = true;
        relinkedLevels++;
        if (!g.isActive) {
          // The level is live again — surface its parent group too.
          await prisma.group.update({ where: { id: g.id }, data: { isActive: true } });
          g.isActive = true;
          await prisma.auditEntry.create({
            data: {
              action: 'GROUP_UPDATED',
              performerId: 'system',
              performerName: 'Platform Sync',
              groupId: g.id,
              details: { source: 'platform-sync', platform, slug: g.slug, reactivated: true, reason: 'level re-linked to a live platform group' },
            },
          });
        }
      }
    }

    // ── 2. Heal groups whose backing platform group was recreated under a new id ──
    for (const g of hermesGroups) {
      if (deletedGroupIds.has(g.id) || !g.externalGroupId) continue;
      const linkIntact = cachedIds.has(g.externalGroupId) && !reservedIds.has(g.externalGroupId);
      if (linkIntact) continue;
      const candidate = byName.get(this.normalizeName(g.name));
      if (!candidate || !(await claimForRelink(candidate.externalId))) continue;
      await prisma.group.update({
        where: { id: g.id },
        data: { externalGroupId: candidate.externalId, isActive: true },
      });
      await prisma.auditEntry.create({
        data: {
          action: 'GROUP_UPDATED',
          performerId: 'system',
          performerName: 'Platform Sync',
          groupId: g.id,
          details: {
            source: 'platform-sync', platform, slug: g.slug,
            relinkedFrom: g.externalGroupId, relinkedTo: candidate.externalId, reactivated: !g.isActive,
          },
        },
      });
      referencedIds.add(candidate.externalId);
      g.externalGroupId = candidate.externalId;
      g.isActive = true;
      relinkedGroups++;
    }

    // Lookup of (non-deleted) Hermes groups by normalized name — the parent
    // resolver for the "<Group> — <Level>" naming convention below.
    const parentByName = new Map<string, (typeof hermesGroups)[number]>();
    for (const g of hermesGroups) {
      if (!deletedGroupIds.has(g.id)) parentByName.set(this.normalizeName(g.name), g);
    }

    /** Attach a live platform group as a level of `parent`, reactivating the parent if needed. */
    const attachLevel = async (
      parent: (typeof hermesGroups)[number],
      levelName: string,
      externalGroupId: string,
    ): Promise<void> => {
      const slug = this.uniqueLevelSlug(levelName, parent.levels);
      const rank = parent.levels.reduce((m, l) => Math.max(m, l.rank), -1) + 1;
      const level = await prisma.groupLevel.create({
        data: { groupId: parent.id, name: levelName, slug, externalGroupId, rank },
      });
      parent.levels.push(level);
      referencedIds.add(externalGroupId);
      await prisma.auditEntry.create({
        data: {
          action: 'GROUP_LEVEL_CREATED',
          performerId: 'system',
          performerName: 'Platform Sync',
          groupId: parent.id,
          details: { source: 'platform-sync', platform, levelId: level.id, name: levelName, slug, externalGroupId, autoCreated: true },
        },
      });
      if (!parent.isActive) {
        await prisma.group.update({ where: { id: parent.id }, data: { isActive: true } });
        parent.isActive = true;
        await prisma.auditEntry.create({
          data: {
            action: 'GROUP_UPDATED',
            performerId: 'system',
            performerName: 'Platform Sync',
            groupId: parent.id,
            details: { source: 'platform-sync', platform, slug: parent.slug, reactivated: true, reason: 'live level attached' },
          },
        });
      }
    };

    // ── 3. Convert stray sync-created groups that are really levels ──
    // A previous sync may have imported a level-backing platform group
    // ("Credit Card — Admin") as a standalone Hermes group because the level
    // structure was missing. If such a group is still pristine, its platform
    // group is alive, and its name parses as "<existing group> — <level>",
    // fold it back into the parent as a level.
    let convertedToLevels = 0, levelsCreated = 0;
    for (const [extId, stray] of [...pristineSyncGroupByExtId]) {
      if (deletedGroupIds.has(stray.id)) continue;
      if (!cachedIds.has(extId) || reservedIds.has(extId)) continue; // dead/reserved → archive pass handles it
      const split = this.splitLevelName(stray.name, parentByName);
      if (!split || split.parent.id === stray.id) continue;
      await attachLevel(split.parent, split.levelName, extId);
      await prisma.group.delete({ where: { id: stray.id } });
      deletedGroupIds.add(stray.id);
      pristineSyncGroupByExtId.delete(extId);
      parentByName.delete(this.normalizeName(stray.name));
      await prisma.auditEntry.create({
        data: {
          action: 'GROUP_DELETED',
          performerId: 'system',
          performerName: 'Platform Sync',
          details: { source: 'platform-sync', platform, slug: stray.slug, externalGroupId: extId, reason: `converted into level "${split.levelName}" of "${split.parent.name}"` },
        },
      });
      convertedToLevels++;
    }

    // ── 4. Create Hermes groups/levels for platform groups Hermes doesn't know yet ──
    // Plain names first, so "Credit Card" exists before "Credit Card — Admin"
    // tries to resolve it as its parent.
    const existingSlugs = new Set((await prisma.group.findMany({ select: { slug: true } })).map(g => g.slug));
    const existingNames = new Set(
      hermesGroups.filter(g => !deletedGroupIds.has(g.id)).map(g => this.normalizeName(g.name)),
    );
    const createCandidates = cached
      .filter(ext => !reservedIds.has(ext.externalId) && !referencedIds.has(ext.externalId))
      .sort((a, b) => Number(/[—–-]/.test(a.name)) - Number(/[—–-]/.test(b.name)));
    for (const ext of createCandidates) {
      if (referencedIds.has(ext.externalId)) continue; // claimed by a level created earlier in this loop
      // "<Group> — <Level>" with a known parent → it's a level, not a group.
      const split = this.splitLevelName(ext.name, parentByName);
      if (split) {
        await attachLevel(split.parent, split.levelName, ext.externalId);
        levelsCreated++;
        continue;
      }
      if (existingNames.has(this.normalizeName(ext.name))) {
        // A group with this name already exists on this platform but maps to a
        // different (or no) external group — ambiguous, leave it to the admin.
        logger.warn(
          { platform, externalGroupId: ext.externalId, name: ext.name },
          '🔄 SyncService: platform group name collides with an existing Hermes group — skipped auto-create',
        );
        continue;
      }
      const slug = this.uniqueSlug(ext.name, platform, existingSlugs);
      const description =
        (ext.metadata as Record<string, unknown> | null)?.['description'] as string | undefined
        ?? `Imported automatically from ${adapter.displayName} by platform sync.`;
      const group = await prisma.group.create({
        data: { name: ext.name, slug, description, platform, externalGroupId: ext.externalId, tables: [] },
      });
      existingSlugs.add(slug);
      existingNames.add(this.normalizeName(ext.name));
      referencedIds.add(ext.externalId);
      parentByName.set(this.normalizeName(group.name), { ...group, levels: [], _count: { accessRequests: 0, userAccesses: 0 } });
      await prisma.auditEntry.create({
        data: {
          action: 'GROUP_CREATED',
          performerId: 'system',
          performerName: 'Platform Sync',
          groupId: group.id,
          details: { source: 'platform-sync', platform, slug, externalGroupId: ext.externalId },
        },
      });
      created++;
    }

    // ── 5. Deactivate levels whose backing platform group vanished ──
    for (const g of hermesGroups) {
      if (deletedGroupIds.has(g.id)) continue;
      for (const level of g.levels) {
        if (!level.isActive || !level.externalGroupId) continue;
        if (level.createdAt > graceCutoff) continue;
        if (cachedIds.has(level.externalGroupId) && !reservedIds.has(level.externalGroupId)) continue;
        await prisma.groupLevel.update({ where: { id: level.id }, data: { isActive: false } });
        level.isActive = false; // keep the in-memory copy honest for step 3
        await prisma.auditEntry.create({
          data: {
            action: 'GROUP_LEVEL_DEACTIVATED',
            performerId: 'system',
            performerName: 'Platform Sync',
            groupId: g.id,
            details: { source: 'platform-sync', platform, levelId: level.id, slug: level.slug, externalGroupId: level.externalGroupId },
          },
        });
        levelsDeactivated++;
      }
    }

    // ── 6. Archive active Hermes groups whose backing platform group vanished ──
    for (const g of hermesGroups) {
      if (deletedGroupIds.has(g.id)) continue;
      if (!g.isActive || !g.externalGroupId) continue;
      if (g.createdAt > graceCutoff) continue;
      const baseGone = !cachedIds.has(g.externalGroupId) || reservedIds.has(g.externalGroupId);
      if (!baseGone) continue;
      // A leveled group provisions through its levels, not the base group — keep
      // it visible as long as at least one level is still backed by a live group.
      if (g.levels.some(l => l.isActive && l.externalGroupId && cachedIds.has(l.externalGroupId))) continue;
      await prisma.group.update({ where: { id: g.id }, data: { isActive: false } });
      await prisma.auditEntry.create({
        data: {
          action: 'GROUP_ARCHIVED',
          performerId: 'system',
          performerName: 'Platform Sync',
          groupId: g.id,
          details: { source: 'platform-sync', platform, slug: g.slug, externalGroupId: g.externalGroupId },
        },
      });
      archived++;
    }

    if (created || levelsCreated || archived || levelsDeactivated || relinkedGroups || relinkedLevels || duplicatesDeleted || convertedToLevels) {
      logger.info(
        { platform, created, levelsCreated, archived, levelsDeactivated, relinkedGroups, relinkedLevels, duplicatesDeleted, convertedToLevels },
        '🔄 SyncService: Hermes groups reconciled with platform',
      );
    }
  }

  /**
   * Normalize a group name for matching: case-, whitespace- and dash-insensitive
   * ("Credit Card — Admin", "credit card - admin" and "Credit Card—Admin" all
   * compare equal), so healing survives em-dash vs hyphen differences.
   */
  private normalizeName(name: string): string {
    return name.toLowerCase().replace(/\s*[—–-]+\s*/g, ' — ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Try to parse a platform group name as "<Parent> — <Level>" against the known
   * Hermes groups of the platform. Tries every dash position (so a hyphen inside
   * the parent's own name can't break the match) and returns the first split
   * whose prefix is an existing group. Null when the name isn't a level of any
   * known group.
   */
  private splitLevelName<T>(
    rawName: string,
    parentByName: Map<string, T>,
  ): { parent: T; levelName: string } | null {
    const sep = /\s*[—–-]+\s*/g;
    let m: RegExpExecArray | null;
    while ((m = sep.exec(rawName)) !== null) {
      const prefix = rawName.slice(0, m.index);
      const levelName = rawName.slice(m.index + m[0].length);
      if (!prefix || !levelName) continue;
      const parent = parentByName.get(this.normalizeName(prefix));
      if (parent) return { parent, levelName };
    }
    return null;
  }

  /** Derive a level slug from its name, unique within the parent's levels. */
  private uniqueLevelSlug(name: string, siblings: Array<{ slug: string }>): string {
    const taken = new Set(siblings.map(l => l.slug));
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'level';
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** Derive a URL-safe slug from a platform group name, unique across all groups. */
  private uniqueSlug(name: string, platform: string, taken: Set<string>): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
    if (!taken.has(base)) return base;
    const platformed = `${platform}-${base}`;
    if (!taken.has(platformed)) return platformed;
    for (let i = 2; ; i++) {
      const candidate = `${platformed}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /**
   * Fast-path single-user refresh for the user-creation "sync now" button.
   * Platform-aware: resolves the adapter via the registry and uses its optional
   * `syncSingleUser` hook. Returns false if the platform's adapter doesn't support
   * it or the user isn't there yet.
   */
  async syncSingleUser(email: string, platform: string = config.platform.default): Promise<boolean> {
    logger.info({ email, platform }, '🔄 SyncService: Fast-path single-user sync...');
    try {
      const adapter = provisioningRegistry.get(platform);
      if (!adapter.syncSingleUser) {
        logger.warn({ platform }, '🔄 SyncService: adapter has no single-user sync; skipping');
        return false;
      }
      return await adapter.syncSingleUser(email);
    } catch (error: any) {
      logger.error({ email, platform, error: error.message }, '🔄 SyncService: Single user sync failed');
      return false;
    }
  }
}

export const syncService = new SyncService();
export default syncService;
