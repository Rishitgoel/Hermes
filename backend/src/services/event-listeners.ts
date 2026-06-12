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

  // Bulk submit: one consolidated notification fan-out instead of N per-request ones.
  eventBus.on('requests.bulk.created', async (event) => {
    try {
      const { requesterName, duration, items } = event.payload as any;
      await notificationService.notifyRequestsCreatedBulk(requesterName, duration, items);
    } catch (err: any) {
      logger.error('Failed to notify requests.bulk.created event:', err.message);
    }
  });

  eventBus.on('request.approved', async (event) => {
    try {
      const { requesterId, groupName, reviewerName, note, requesterEmail } = event.payload as any;
      await notificationService.notifyRequestReviewed(requesterId, groupName, true, reviewerName, note, requesterEmail);
    } catch (err: any) {
      logger.error('Failed to notify request.approved event:', err.message);
    }
  });

  eventBus.on('request.rejected', async (event) => {
    try {
      const { requesterId, groupName, reviewerName, note, requesterEmail } = event.payload as any;
      await notificationService.notifyRequestReviewed(requesterId, groupName, false, reviewerName, note, requesterEmail);
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

  // Auto-expiry permanently failed after retries — alert admins for manual cleanup.
  eventBus.on('access.expiry-failed', async (event) => {
    try {
      const { userAccessId, userName, groupName, attempts, error, platform } = event.payload as any;
      await notificationService.notifyExpiryFailed(userAccessId, userName, groupName, attempts, error, platform);
    } catch (err: any) {
      logger.error('Failed to notify access.expiry-failed event:', err.message);
    }
  });

  // Group access request approved but waiting for the user to finish Redash setup.
  eventBus.on('access.queued-for-setup', async (event) => {
    try {
      const { requesterId, groupName, reviewerName, platform } = event.payload as any;
      await notificationService.notifyAccessQueuedForSetup(requesterId, groupName, reviewerName, platform);
    } catch (err: any) {
      logger.error('Failed to notify access.queued-for-setup event:', err.message);
    }
  });

  // User-creation lifecycle
  eventBus.on('user-creation.submitted', async (event) => {
    try {
      const { requestId, userName, userEmail, justification, platform } = event.payload as any;
      await notificationService.notifyUserCreationSubmitted(requestId, userName, userEmail, justification, platform);
    } catch (err: any) {
      logger.error('Failed to notify user-creation.submitted event:', err.message);
    }
  });

  eventBus.on('user-creation.invited', async (event) => {
    try {
      const { userId, userEmail, reviewerName, platform } = event.payload as any;
      await notificationService.notifyUserCreationApproved(userId, userEmail, reviewerName, platform);
    } catch (err: any) {
      logger.error('Failed to notify user-creation.invited event:', err.message);
    }
  });

  eventBus.on('user-creation.rejected', async (event) => {
    try {
      const { userId, reviewerName, note, userEmail } = event.payload as any;
      await notificationService.notifyUserCreationRejected(userId, reviewerName, note, userEmail);
    } catch (err: any) {
      logger.error('Failed to notify user-creation.rejected event:', err.message);
    }
  });

  eventBus.on('user-creation.completed', async (event) => {
    try {
      const { userId, userEmail, platform } = event.payload as any;
      await notificationService.notifyUserCreationCompleted(userId, userEmail, platform);
    } catch (err: any) {
      logger.error('Failed to notify user-creation.completed event:', err.message);
    }
  });

  logger.info('📡 Event listeners registered.');
}
