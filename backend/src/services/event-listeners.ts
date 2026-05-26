import eventBus from './event-bus';
import notificationService from './notification.service';
import logger from '../utils/logger';

export function registerEventListeners(): void {
  // Wildcard audit log
  eventBus.on('*', (event) => {
    logger.info({ eventType: event.type }, `[EventBus] Event: ${event.type}`);
  });

  // Notification listeners
  eventBus.on('request.created', async (event) => {
    try {
      const { requestId, groupId, groupName, requesterName, justification, duration } = event.payload as any;
      await notificationService.notifyRequestCreated(requestId, groupId, groupName, requesterName, justification, duration);
    } catch (err: any) {
      logger.error('Failed to notify request.created event:', err.message);
    }
  });

  eventBus.on('request.approved', async (event) => {
    try {
      const { requesterId, groupName, reviewerName, note } = event.payload as any;
      await notificationService.notifyRequestReviewed(requesterId, groupName, true, reviewerName, note);
    } catch (err: any) {
      logger.error('Failed to notify request.approved event:', err.message);
    }
  });

  eventBus.on('request.rejected', async (event) => {
    try {
      const { requesterId, groupName, reviewerName, note } = event.payload as any;
      await notificationService.notifyRequestReviewed(requesterId, groupName, false, reviewerName, note);
    } catch (err: any) {
      logger.error('Failed to notify request.rejected event:', err.message);
    }
  });

  eventBus.on('access.revoked', async (event) => {
    try {
      const { userId, groupName, revokerName, reason } = event.payload as any;
      await notificationService.notifyAccessRevoked(userId, groupName, revokerName, reason);
    } catch (err: any) {
      logger.error('Failed to notify access.revoked event:', err.message);
    }
  });

  eventBus.on('access.expired', async (event) => {
    try {
      const { userId, groupName } = event.payload as any;
      await notificationService.notifyAccessExpired(userId, groupName);
    } catch (err: any) {
      logger.error('Failed to notify access.expired event:', err.message);
    }
  });

  logger.info('📡 Event listeners registered.');
}
