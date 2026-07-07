import { EventEmitter } from 'events';
import logger from '../utils/logger';

export interface AccessEvent {
  type:
    | 'request.created'
    | 'requests.bulk.created'
    | 'request.approved'
    | 'request.rejected'
    | 'access.granted'
    | 'access.revoked'
    | 'access.expired'
    | 'access.expiring'
    | 'access.expiry-failed'
    | 'access.queued-for-setup'
    | 'provision.failed'
    | 'sync.triggered'
    | 'user-creation.submitted'
    | 'user-creation.invited'
    | 'user-creation.rejected'
    | 'user-creation.completed'
    | 'zk-change.submitted'
    | 'zk-change.reviewed';
  payload: Record<string, unknown>;
  timestamp: Date;
}

/**
 * Fired whenever an in-app Notification row is persisted (the single chokepoint in
 * notificationService.createNotification). Carries the recipient `userId` so the SSE
 * stream can forward it to exactly that user's open connections — no need to
 * re-derive recipients from each domain event.
 */
export interface NotificationCreatedEvent {
  userId: string;
  notification: {
    id: string;
    userId: string;
    title: string;
    message: string;
    linkUrl: string | null;
    isRead: boolean;
    createdAt: Date;
  };
}

class HermesEventBus extends EventEmitter {
  emitAccessEvent(event: AccessEvent): void {
    logger.debug({ event: event.type }, `Event emitted: ${event.type}`);
    this.emit(event.type, event);
    this.emit('*', event); // Wildcard listener for audit/logging
  }

  emitNotificationCreated(event: NotificationCreatedEvent): void {
    this.emit('notification.created', event);
  }
}

export const eventBus = new HermesEventBus();
export default eventBus;
