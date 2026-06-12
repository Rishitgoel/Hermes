import type { Response } from 'express';
import eventBus, { NotificationCreatedEvent } from './event-bus';
import logger from '../utils/logger';

/**
 * In-process Server-Sent Events hub for in-app notifications (P2-6, replaces the
 * frontend's 60s polling). Holds the set of open SSE `Response`s per user and a
 * SINGLE `notification.created` listener on the event bus that fans each new
 * notification out to that user's connections. Using one bus listener (rather than
 * one-per-connection) keeps us clear of EventEmitter's max-listeners warning no
 * matter how many tabs/users connect.
 *
 * BullMQ caveat (P3-2): when the event bus moves to Redis, this subscribes to the
 * queue's `notification.created` events instead of the in-process emitter — the
 * controller/route and the client registry below stay the same.
 */
class NotificationStreamService {
  private clients = new Map<string, Set<Response>>();
  private subscribed = false;

  private ensureSubscribed(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    eventBus.on('notification.created', (event: NotificationCreatedEvent) => {
      const conns = this.clients.get(event.userId);
      if (!conns || conns.size === 0) return;
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
    if (!set) return;
    set.delete(res);
    if (set.size === 0) this.clients.delete(userId);
  }

  /** Total open connections across all users (diagnostics). */
  get connectionCount(): number {
    let total = 0;
    for (const set of this.clients.values()) total += set.size;
    return total;
  }
}

export const notificationStreamService = new NotificationStreamService();
export default notificationStreamService;
