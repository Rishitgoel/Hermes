import { createClient, RedisClientType } from 'redis';
import { randomUUID } from 'crypto';
import os from 'os';
import logger from '../utils/logger';

/**
 * Redis-based leader election for the Hermes background machinery.
 *
 * Hermes now boots inside admin-panel, which runs MULTIPLE replicas in prod. The
 * scheduler (auto-revoke / periodic platform sync / admin reconciliation), the
 * initial platform cache sync, and the shared-Keycloak client/role ensure all
 * mutate SHARED state — external platforms (Redash / AWS Identity Center), the
 * shared `platform_external_groups` DB cache, and the prod Keycloak realm. Running
 * them on every replica means duplicate deprovision calls against the same grants,
 * external-platform rate-limit pressure, and N redundant writes to the prod IdP.
 *
 * This elects exactly ONE replica to run that work. It uses a single Redis key held
 * with `SET NX PX` and renewed on a heartbeat; if the leader dies, the key's TTL
 * lapses and a standby acquires it within `LOCK_TTL_MS`. A Lua compare-and-set
 * guards renew/release so a replica can only renew/release a lock it still owns
 * (avoids the classic "expired-then-reacquired-by-another" race).
 *
 * Failure posture: if Redis is unreachable, NO replica becomes leader, so the
 * scheduler does not run anywhere (safe — never duplicated). It is self-healing —
 * every tick retries the connection, and a replica acquires leadership as soon as
 * Redis recovers. The outage is logged loudly so the paused auto-revoke is visible.
 */

const LOCK_KEY =
  process.env.HERMES_LEADER_LOCK_KEY || 'hermes:scheduler:leader';
const LOCK_TTL_MS = parseInt(
  process.env.HERMES_LEADER_LOCK_TTL_MS || '30000',
  10,
);
// Renew (and, for standbys, re-attempt acquire) at ~1/3 of the TTL so a single
// transient Redis blip doesn't cost us the lock.
const RENEW_INTERVAL_MS = Math.max(2000, Math.floor(LOCK_TTL_MS / 3));

// Renew only if we still own the key. Returns 1 on success, 0 if we no longer hold it.
const RENEW_LUA =
  'if redis.call(\'get\', KEYS[1]) == ARGV[1] then return redis.call(\'pexpire\', KEYS[1], ARGV[2]) else return 0 end';
// Release only if we still own the key (don't delete a lock another replica took over).
const RELEASE_LUA =
  'if redis.call(\'get\', KEYS[1]) == ARGV[1] then return redis.call(\'del\', KEYS[1]) else return 0 end';

export interface LeaderCallbacks {
  /** Invoked when this replica becomes the leader (start scheduler work). */
  onElected: () => void | Promise<void>;
  /** Invoked when this replica loses leadership (stop scheduler work). */
  onDeposed: () => void | Promise<void>;
}

class LeaderElectionService {
  private client: RedisClientType | null = null;
  // Unique per process: host + pid + random suffix. Two replicas can't collide.
  private readonly instanceId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private isLeader = false;
  private timer: NodeJS.Timeout | null = null;
  private callbacks: LeaderCallbacks | null = null;
  private running = false;

  /** Whether this replica currently holds leadership. */
  get leader(): boolean {
    return this.isLeader;
  }

  get id(): string {
    return this.instanceId;
  }

  async start(callbacks: LeaderCallbacks): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.callbacks = callbacks;

    const host = process.env.REDIS_HOST || 'localhost';
    const port = process.env.REDIS_PORT || '6379';
    const db = process.env.REDIS_DB || '0';
    const auth = process.env.REDIS_PASSWORD
      ? `:${process.env.REDIS_PASSWORD}@`
      : '';
    this.client = createClient({
      url: `redis://${auth}${host}:${port}/${db}`,
      // Keep retrying forever (capped backoff) — a Redis outage should pause the
      // scheduler, not permanently disable it.
      socket: { reconnectStrategy: retries => Math.min(retries * 100, 3000) },
    });
    // node-redis emits 'error' on every failed (re)connect; swallow at warn so an
    // unhandled 'error' event can't crash the process.
    this.client.on('error', err => {
      logger.warn(
        `🗳  Leader election: Redis error (${(err as Error)?.message ?? err}). Scheduler paused on this replica until Redis recovers.`,
      );
    });

    await this.ensureConnected();
    logger.info(
      `🗳  Leader election started (instance ${this.instanceId}, lock '${LOCK_KEY}', ttl ${LOCK_TTL_MS}ms, renew ${RENEW_INTERVAL_MS}ms).`,
    );

    await this.tick();
    this.timer = setInterval(() => void this.tick(), RENEW_INTERVAL_MS);
    // Don't keep the event loop alive solely for the election heartbeat.
    this.timer.unref?.();
  }

  /** Best-effort (re)connect. Stays disconnected on failure; retried next tick. */
  private async ensureConnected(): Promise<void> {
    if (!this.client || this.client.isOpen) {
      return;
    }
    try {
      await this.client.connect();
    } catch (err) {
      logger.warn(
        `🗳  Leader election: Redis connect attempt failed (will retry): ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async tick(): Promise<void> {
    await this.ensureConnected();
    if (!this.client?.isReady) {
      return;
    }
    try {
      if (this.isLeader) {
        const renewed = await this.client.eval(RENEW_LUA, {
          keys: [LOCK_KEY],
          arguments: [this.instanceId, String(LOCK_TTL_MS)],
        });
        if (renewed !== 1) {
          // Lost the lock (TTL lapsed during a Redis blip, or taken over). Step
          // down, then try to reclaim immediately.
          await this.stepDown('renew failed — lock no longer held');
          await this.tryAcquire();
        }
      } else {
        await this.tryAcquire();
      }
    } catch (err) {
      logger.warn(
        `🗳  Leader election tick failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async tryAcquire(): Promise<void> {
    if (!this.client?.isReady) {
      return;
    }
    const acquired = await this.client.set(LOCK_KEY, this.instanceId, {
      NX: true,
      PX: LOCK_TTL_MS,
    });
    if (acquired === 'OK') {
      this.isLeader = true;
      logger.info(
        `🗳  Leader election: this replica (${this.instanceId}) is now the LEADER.`,
      );
      try {
        await this.callbacks?.onElected();
      } catch (err) {
        logger.error(
          `🗳  Leader election: onElected handler failed: ${(err as Error)?.message ?? err}`,
        );
      }
    }
  }

  private async stepDown(reason: string): Promise<void> {
    if (!this.isLeader) {
      return;
    }
    this.isLeader = false;
    logger.warn(`🗳  Leader election: stepping down (${reason}).`);
    try {
      await this.callbacks?.onDeposed();
    } catch (err) {
      logger.error(
        `🗳  Leader election: onDeposed handler failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /** Stop the heartbeat and release leadership so a standby can take over without waiting out the TTL. */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      if (this.client?.isReady && this.isLeader) {
        await this.client.eval(RELEASE_LUA, {
          keys: [LOCK_KEY],
          arguments: [this.instanceId],
        });
        logger.info(
          '🗳  Leader election: released leadership lock on shutdown.',
        );
      }
    } catch (err) {
      logger.warn(
        `🗳  Leader election: failed to release lock on shutdown: ${(err as Error)?.message ?? err}`,
      );
    }
    this.isLeader = false;
    try {
      await this.client?.quit();
    } catch {
      // ignore — shutting down anyway
    }
    this.client = null;
  }
}

export const leaderElectionService = new LeaderElectionService();
export default leaderElectionService;
