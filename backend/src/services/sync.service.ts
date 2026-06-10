import provisioningRegistry from './provisioning.registry';
import config from '../config/config';
import logger from '../utils/logger';

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
    this.lastSyncedAt = new Date();
    return { usersSynced: users.count, groupsSynced: groups.count };
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
