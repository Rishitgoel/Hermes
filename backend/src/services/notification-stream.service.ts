import type { Response } from 'express';
import eventBus, { NotificationCreatedEvent } from './event-bus';
import logger from '../utils/logger';

/**
 * Optional cross-replica fanout transport. When Hermes runs as several replicas
 * behind a load balancer, a notification created by an API request on replica A
 * must reach the recipient's SSE connection, which may be held by replica B. A
 * transport (e.g. Redis pub/sub — see notification-redis-relay.service in
 * admin-panel) broadcasts each event to every replica; each replica then calls
 * {@link NotificationStreamService.deliver} for its own connections. Without a
 * transport (standalone/dev), events are delivered in-process, as before.
 */
export interface NotificationTransport {
  publish(event: NotificationCreatedEvent): void;
}

/**
 * In-process Server-Sent Events hub for in-app notifications (P2-6, replaces the
 * frontend's 60s polling). Holds the set of open SSE `Response`s per user and a
 * SINGLE `notification.created` listener on the event bus that fans each new
 * notification out to that user's connections. Using one bus listener (rather than
 * one-per-connection) keeps us clear of EventEmitter's max-listeners warning no
 * matter how many tabs/users connect.
 */
class NotificationStreamService {
  private clients = new Map<string, Set<Response>>();
  private subscribed = false;
  private transport: NotificationTransport | null = null;

  /**
   * Route bus events through an external transport instead of delivering locally.
   * The transport MUST loop published events back into {@link deliver} on EVERY
   * replica, including the publishing one (Redis pub/sub delivers to the
   * publishing subscriber too, so that's automatic there) — local delivery is
   * skipped while a transport is set, to avoid double-sending. Subscribes the bus
   * listener eagerly: with a transport, THIS replica must publish events even when
   * it holds no SSE connections itself.
   */
  setTransport(transport: NotificationTransport | null): void {
    this.transport = transport;
    if (transport) {this.ensureSubscribed();}
  }

  /** Fan a notification out to the recipient's open SSE connections on THIS replica. */
  deliver(event: NotificationCreatedEvent): void {
    const conns = this.clients.get(event.userId);
    if (!conns || conns.size === 0) {return;}
    const frame = `event: notification\ndata: ${JSON.stringify(event.notification)}\n\n`;
    for (const res of conns) {
      try {
        res.write(frame);
      } catch (err) {
        logger.warn(
          { userId: event.userId, err: (err as Error)?.message },
          'SSE write failed; dropping notification connection',
        );
        this.removeClient(event.userId, res);
      }
    }
  }

  private ensureSubscribed(): void {
    if (this.subscribed) {return;}
    this.subscribed = true;
    eventBus.on('notification.created', (event: NotificationCreatedEvent) => {
      if (this.transport) {
        this.transport.publish(event);
        return;
      }
      this.deliver(event);
    });
  }

  addClient(userId: string, res: Response): void {
    this.ensureSubscribed();
    let set = this.clients.get(userId);
    if (!set) {
      set = new Set<Response>();
      this.clients.set(userId, set);
    }
    set.add(res);
    logger.debug({ userId, connections: set.size }, 'SSE notification client connected');
  }

  removeClient(userId: string, res: Response): void {
    const set = this.clients.get(userId);
    if (!set) {return;}
    set.delete(res);
    if (set.size === 0) {this.clients.delete(userId);}
  }

  /** Total open connections across all users (diagnostics). */
  get connectionCount(): number {
    let total = 0;
    for (const set of this.clients.values()) {total += set.size;}
    return total;
  }
}

export const notificationStreamService = new NotificationStreamService();
export default notificationStreamService;
