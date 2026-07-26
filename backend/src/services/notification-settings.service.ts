import prisma from '../config/prisma';
import logger from '../utils/logger';
import type {
  NotificationChannel,
  NotificationScenario,
} from './notification-scenarios';

/**
 * The global, super-admin-controlled switchboard for outbound notifications.
 *
 * Stored in the existing `SystemSetting` key/value table rather than a dedicated
 * model — roughly forty booleans do not justify a migration, and the type safety
 * comes from the `NotificationScenario` union in `notification-scenarios.ts`,
 * not from the schema. Keys look like:
 *
 *   notify:<scenario>:<channel>   e.g. notify:access.request.created:email
 *   notify:master:<channel>       the two kill switches
 *
 * **An absent row means enabled.** A fresh deploy writes nothing and behaves
 * exactly as it did before this feature existed; rows only appear once someone
 * turns something off (or back on).
 *
 * The master switches are an *override*, not a bulk write: flipping "All Email"
 * off suppresses every email while leaving the per-scenario rows untouched, so
 * turning it back on restores the previous grid exactly.
 *
 * ## Caching
 *
 * Every notification send asks this service, so the answer is cached in-process
 * for 30 seconds. `invalidate()` is called on every write, which makes the
 * change instant on the process that served the request. In the multi-replica
 * admin-panel deployment sibling replicas keep serving the old value until their
 * own TTL lapses — deliberately accepted. A stale read costs a handful of
 * notifications sent under the previous policy and heals itself within 30s,
 * which does not justify the Redis pub/sub machinery (whose own failure mode —
 * a silently dead subscriber — is indistinguishable from normal TTL lag). If
 * that ever needs to be tighter, `invalidate()` is the single seam to hang a
 * subscriber on.
 */

const KEY_PREFIX = 'notify:';
const TTL_MS = 30_000;

/** How long a stale read can persist on a replica that didn't serve the write. */
export const SETTINGS_PROPAGATION_SECONDS = TTL_MS / 1000;

export type MasterScenario = 'master';

export class NotificationSettingsService {
  private cache: Map<string, boolean> | null = null;
  private expiresAt = 0;
  private inFlight: Promise<Map<string, boolean> | null> | null = null;

  private static key(
    scenario: NotificationScenario | MasterScenario,
    channel: NotificationChannel,
  ): string {
    return `${KEY_PREFIX}${scenario}:${channel}`;
  }

  /**
   * Load every `notify:*` row, cached. Returns null when the database could not
   * be read, which callers treat as "no opinion" — see the fail-open note on
   * `isEnabled`. Concurrent callers share one query rather than stampeding.
   */
  private async load(): Promise<Map<string, boolean> | null> {
    if (this.cache && Date.now() < this.expiresAt) {
      return this.cache;
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = (async () => {
      try {
        const rows = await prisma.systemSetting.findMany({
          where: { key: { startsWith: KEY_PREFIX } },
        });
        const map = new Map<string, boolean>(
          rows.map(r => [r.key, r.value === 'true']),
        );
        this.cache = map;
        this.expiresAt = Date.now() + TTL_MS;
        return map;
      } catch (error: any) {
        logger.warn(
          { err: error.message },
          'Failed to read notification settings; falling back to "everything enabled"',
        );
        return null;
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  /**
   * Whether a scenario may deliver on a channel right now.
   *
   * **Fails open.** If the settings cannot be read, everything sends. Silently
   * muting the entire system on a transient database error would be invisible —
   * nobody notices notifications that never arrive — whereas an unwanted send is
   * self-evident and recoverable. Same reasoning as `isInfraAutoMergeEnabled`.
   */
  async isEnabled(
    scenario: NotificationScenario,
    channel: NotificationChannel,
  ): Promise<boolean> {
    const map = await this.load();
    if (!map) {
      return true;
    }
    if (map.get(NotificationSettingsService.key('master', channel)) === false) {
      return false;
    }
    return map.get(NotificationSettingsService.key(scenario, channel)) ?? true;
  }

  /** Both channels for one scenario, in a single cache read. */
  async getChannels(
    scenario: NotificationScenario,
  ): Promise<Record<NotificationChannel, boolean>> {
    const [email, slack] = await Promise.all([
      this.isEnabled(scenario, 'email'),
      this.isEnabled(scenario, 'slack'),
    ]);
    return { email, slack };
  }

  /**
   * The raw stored state for the settings screen — per-scenario values *without*
   * the master override folded in, so turning a master back on reveals the grid
   * unchanged. Throws on a database error: the screen must never render a
   * fabricated "everything is on" that the admin would then act upon.
   */
  async getAllRaw(): Promise<{
    masters: Record<NotificationChannel, boolean>;
    scenarios: Map<string, Partial<Record<NotificationChannel, boolean>>>;
  }> {
    const rows = await prisma.systemSetting.findMany({
      where: { key: { startsWith: KEY_PREFIX } },
    });

    const masters: Record<NotificationChannel, boolean> = {
      email: true,
      slack: true,
    };
    const scenarios = new Map<
      string,
      Partial<Record<NotificationChannel, boolean>>
    >();

    for (const row of rows) {
      // notify:<scenario>:<channel> — the scenario itself contains dots, so split
      // off the trailing channel segment rather than splitting on every colon.
      const rest = row.key.slice(KEY_PREFIX.length);
      const sep = rest.lastIndexOf(':');
      if (sep === -1) {
        continue;
      }
      const scenario = rest.slice(0, sep);
      const channel = rest.slice(sep + 1) as NotificationChannel;
      if (channel !== 'email' && channel !== 'slack') {
        continue;
      }
      const enabled = row.value === 'true';

      if (scenario === 'master') {
        masters[channel] = enabled;
        continue;
      }
      const entry = scenarios.get(scenario) ?? {};
      entry[channel] = enabled;
      scenarios.set(scenario, entry);
    }

    return { masters, scenarios };
  }

  /** Persist one toggle and make it take effect immediately on this process. */
  async set(
    scenario: NotificationScenario | MasterScenario,
    channel: NotificationChannel,
    enabled: boolean,
  ): Promise<void> {
    const key = NotificationSettingsService.key(scenario, channel);
    const value = enabled ? 'true' : 'false';
    await prisma.systemSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    this.invalidate();
    logger.info({ key, value }, 'Notification setting updated');
  }

  /** Drop the cache so the next read hits the database. */
  invalidate(): void {
    this.cache = null;
    this.expiresAt = 0;
  }
}

export const notificationSettingsService = new NotificationSettingsService();
export default notificationSettingsService;
