import { createClient, RedisClientType } from 'redis';
import notificationStreamService from './notification-stream.service';
import { NotificationCreatedEvent } from './event-bus';
import logger from '../utils/logger';

/**
 * Cross-replica SSE notification relay (ADMIN-PANEL ONLY, like
 * leader-election.service — multi-replica is an admin-panel concern).
 *
 * admin-panel runs several replicas in prod. A user's SSE notification stream is
 * held by whichever replica their EventSource landed on, but the API request that
 * creates a notification (an admin approving their request, say) may be served by
 * a DIFFERENT replica — with the in-process event bus alone, that notification
 * never reaches the user's open tab. This relay broadcasts every
 * `notification.created` event over a Redis pub/sub channel; every replica
 * subscribes and delivers to its own local SSE connections.
 *
 * Wiring: {@link notificationStreamService.setTransport} routes bus events into
 * `publish` here INSTEAD of local delivery; Redis loops the message back to the
 * publishing replica's own subscriber too, so local tabs still receive it exactly
 * once. The transport is only installed AFTER the subscription is live, so a
 * Redis outage at boot simply leaves the previous (in-process) behavior in place.
 * If a later publish fails (Redis blip), the event is delivered locally as a
 * fallback so the publishing replica's own connections aren't silently dropped.
 *
 * No-op without REDIS_HOST (dev/single-instance — local delivery already works).
 */

const CHANNEL =
  process.env.HERMES_NOTIFY_CHANNEL || 'hermes:notifications:created';

class NotificationRedisRelayService {
  private pub: RedisClientType | null = null;
  private sub: RedisClientType | null = null;
  private running = false;

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    if (!process.env.REDIS_HOST) {
      logger.info(
        '🔔 Notification relay: REDIS_HOST not set — SSE notifications stay in-process (single-instance mode).',
      );
      return;
    }
    this.running = true;

    const host = process.env.REDIS_HOST;
    const port = process.env.REDIS_PORT || '6379';
    const db = process.env.REDIS_DB || '0';
    const auth = process.env.REDIS_PASSWORD
      ? `:${process.env.REDIS_PASSWORD}@`
      : '';
    const url = `redis://${auth}${host}:${port}/${db}`;

    // Pub/sub needs two connections: a subscribed client can't issue PUBLISH.
    this.pub = createClient({
      url,
      socket: { reconnectStrategy: retries => Math.min(retries * 100, 3000) },
    });
    this.sub = this.pub.duplicate();
    // node-redis emits 'error' on every failed (re)connect; swallow at warn so an
    // unhandled 'error' event can't crash the process.
    const onError = (side: string) => (err: unknown) =>
      logger.warn(
        `🔔 Notification relay: Redis ${side} error (${(err as Error)?.message ?? err}).`,
      );
    this.pub.on('error', onError('publisher'));
    this.sub.on('error', onError('subscriber'));

    try {
      await Promise.all([this.pub.connect(), this.sub.connect()]);
      await this.sub.subscribe(CHANNEL, message => {
        try {
          const event = JSON.parse(message) as NotificationCreatedEvent;
          notificationStreamService.deliver(event);
        } catch (err) {
          logger.warn(
            `🔔 Notification relay: dropped malformed message (${(err as Error)?.message ?? err}).`,
          );
        }
      });
    } catch (err) {
      // Leave the in-process transport in place; SSE keeps working per-replica.
      logger.warn(
        `🔔 Notification relay: failed to start (${(err as Error)?.message ?? err}). SSE notifications stay in-process on this replica.`,
      );
      await this.stop();
      return;
    }

    notificationStreamService.setTransport({
      publish: event => {
        void this.pub
          ?.publish(CHANNEL, JSON.stringify(event))
          .catch((err: unknown) => {
            logger.warn(
              `🔔 Notification relay: publish failed (${(err as Error)?.message ?? err}); delivering locally only.`,
            );
            notificationStreamService.deliver(event);
          });
      },
    });
    logger.info(
      `🔔 Notification relay started — SSE notifications fan out across replicas via Redis channel '${CHANNEL}'.`,
    );
  }

  /** Detach the transport and close both connections (graceful shutdown). */
  async stop(): Promise<void> {
    notificationStreamService.setTransport(null);
    const clients = [this.pub, this.sub].filter(Boolean) as RedisClientType[];
    this.pub = null;
    this.sub = null;
    this.running = false;
    await Promise.allSettled(clients.map(c => c.quit().catch(() => c.disconnect())));
  }
}

export const notificationRedisRelayService = new NotificationRedisRelayService();
export default notificationRedisRelayService;
