import prisma from '../config/prisma';
import slackService from './slack.service';
import logger from '../utils/logger';
import config from '../config/config';

export class NotificationService {
  // Create a general in-app notification
  async createNotification(
    userId: string,
    title: string,
    message: string,
    linkUrl?: string
  ): Promise<void> {
    try {
      await prisma.notification.create({
        data: {
          userId,
          title,
          message,
          linkUrl,
        },
      });
      logger.info(`🔔 In-app notification created for user ${userId}: "${title}"`);
    } catch (error: any) {
      logger.error(`Failed to create in-app notification for ${userId}:`, error.message);
    }
  }

  // User requests access -> notify Group Admins (in-app) + Slack ping
  async notifyRequestCreated(
    requestId: string,
    groupId: string,
    groupName: string,
    requesterName: string,
    justification: string,
    duration: string
  ): Promise<void> {
    // 1. Send Slack Ping
    const slackMsg = `📋 *Atlas Access Request*\n--------------------------\n*${requesterName}* requested access to the *${groupName}* group.\nReason: "${justification}"\nDuration: ${duration.replace('_', ' ').toLowerCase()}\n\n👉 Review in Atlas: ${config.frontend.url}/pending-approvals`;
    await slackService.sendPing(slackMsg);

    // 2. Query Group Admins from DB and send in-app notification
    try {
      const groupAdmins = await prisma.groupAdmin.findMany({
        where: { groupId },
      });

      for (const admin of groupAdmins) {
        await this.createNotification(
          admin.userId,
          'Pending Approval Request',
          `${requesterName} requested access to ${groupName}.`,
          `/pending-approvals`
        );
      }
    } catch (error: any) {
      logger.error('Failed to notify group admins in-app:', error.message);
    }
  }

  // Request is approved/rejected -> notify requester
  async notifyRequestReviewed(
    requesterId: string,
    groupName: string,
    approved: boolean,
    reviewerName: string,
    note?: string
  ): Promise<void> {
    const statusText = approved ? 'APPROVED' : 'REJECTED';
    const title = `Access Request ${statusText}`;
    const message = approved
      ? `Your access request to ${groupName} was approved by ${reviewerName}.${note ? ` Note: "${note}"` : ''}`
      : `Your access request to ${groupName} was rejected by ${reviewerName}.${note ? ` Reason: "${note}"` : ''}`;

    await this.createNotification(requesterId, title, message, approved ? '/' : '/my-requests');

    // Notify requester via Slack if possible (simulation simply pings admin webhook channel)
    const slackMsg = `📢 *Atlas Access Update*\n--------------------------\nAccess request to *${groupName}* was *${statusText}* by ${reviewerName}.${note ? `\nNote: "${note}"` : ''}`;
    await slackService.sendPing(slackMsg);
  }

  // Access is auto-expired
  async notifyAccessExpired(
    userId: string,
    groupName: string
  ): Promise<void> {
    const title = 'Access Expired';
    const message = `Your temporary access to ${groupName} group has expired.`;

    await this.createNotification(userId, title, message, '/groups');

    const slackMsg = `⏳ *Atlas Access Expired*\n--------------------------\nAccess to *${groupName}* group has expired for User ID: ${userId}`;
    await slackService.sendPing(slackMsg);
  }

  // Access is manually revoked by admin
  async notifyAccessRevoked(
    userId: string,
    groupName: string,
    revokerName: string,
    reason?: string
  ): Promise<void> {
    const title = 'Access Revoked';
    const message = `Your access to ${groupName} group was revoked by ${revokerName}.${reason ? ` Reason: "${reason}"` : ''}`;

    await this.createNotification(userId, title, message, '/groups');

    const slackMsg = `🚫 *Atlas Access Revoked*\n--------------------------\nAccess to *${groupName}* group was revoked by ${revokerName} for User ID: ${userId}.${reason ? `\nReason: "${reason}"` : ''}`;
    await slackService.sendPing(slackMsg);
  }
}

export const notificationService = new NotificationService();
export default notificationService;
