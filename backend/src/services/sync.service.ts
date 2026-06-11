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

  /** Refresh the cache for every registered platform. */
  async syncAllPlatforms(): Promise<{ usersSynced: number; groupsSynced: number }> {
    logger.info('🔄 SyncService: Starting sync across all platforms...');
    let usersSynced = 0;
    let groupsSynced = 0;

    for (const platform of provisioningRegistry.listPlatforms()) {
      try {
        const result = await this.syncSinglePlatform(platform);
        usersSynced += result.usersSynced;
        groupsSynced += result.groupsSynced;
      } catch (err: any) {
        // Isolate per-platform failures so one bad platform can't block the rest.
        logger.error({ platform, error: err.message }, '🔄 SyncService: Platform sync failed');
      }
    }

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
   *  - a platform group not yet represented in Hermes → auto-create an active
   *    Hermes group for it (unless the adapter marks it reserved — e.g. AWS's
   *    API-TESTING permission group or Redash's built-in default/admin groups);
   *  - an active Hermes group whose backing platform group vanished (or is
   *    reserved) → archive it (`isActive: false`) — never hard-delete, history
   *    and grants stay intact;
   *  - an active level whose backing platform group vanished → soft-deactivate it.
   *
   * Runs only when the adapter is live (`isSimulation()` false/absent) so local
   * dev seed data is never reshuffled to match the in-process mock stores, and
   * reads from the `platform_external_groups` cache the adapter just refreshed.
   * Deliberately does NOT auto-reactivate archived groups: archiving is also a
   * deliberate admin action, so a group that reappears on the platform is
   * reactivated by an admin from the Admin Management UI.
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

    const hermesGroups = await prisma.group.findMany({
      where: { platform },
      include: { levels: true },
    });
    // Every external id any Hermes group or level already points at (active or
    // archived) — auto-create must not produce a duplicate mapping, and a
    // level's backing group must not surface as a standalone requestable group.
    const referencedIds = new Set<string>();
    for (const g of hermesGroups) {
      if (g.externalGroupId) referencedIds.add(g.externalGroupId);
      for (const l of g.levels) if (l.externalGroupId) referencedIds.add(l.externalGroupId);
    }

    const graceCutoff = new Date(Date.now() - RECONCILE_GRACE_MS);
    let created = 0, archived = 0, levelsDeactivated = 0;

    // ── 1. Create Hermes groups for platform groups Hermes doesn't know yet ──
    const existingSlugs = new Set((await prisma.group.findMany({ select: { slug: true } })).map(g => g.slug));
    const existingNames = new Set(hermesGroups.map(g => g.name.toLowerCase()));
    for (const ext of cached) {
      if (reservedIds.has(ext.externalId) || referencedIds.has(ext.externalId)) continue;
      if (existingNames.has(ext.name.toLowerCase())) {
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
      existingNames.add(ext.name.toLowerCase());
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

    // ── 2. Deactivate levels whose backing platform group vanished ──
    for (const g of hermesGroups) {
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

    // ── 3. Archive active Hermes groups whose backing platform group vanished ──
    for (const g of hermesGroups) {
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

    if (created || archived || levelsDeactivated) {
      logger.info(
        { platform, created, archived, levelsDeactivated },
        '🔄 SyncService: Hermes groups reconciled with platform',
      );
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
