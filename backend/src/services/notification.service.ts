import prisma from '../config/prisma';
import slackService from './slack.service';
import logger from '../utils/logger';
import config from '../config/config';
import keycloakSetupService from '../config/keycloak-setup';

/**
 * Escape user-supplied text before interpolating into a Slack message.
 * Slack's mrkdwn would otherwise let a `<!here>` or `<@U123>` in a justification
 * ping channels or impersonate user links. Replace the four mrkdwn metacharacters
 * with HTML entities Slack renders as plain text.
 */
function escapeSlackText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
    const slackMsg = `📋 *Hermes Access Request*\n--------------------------\n*${escapeSlackText(requesterName)}* requested access to the *${escapeSlackText(groupName)}* group.\nReason: "${escapeSlackText(justification)}"\nDuration: ${duration.replace('_', ' ').toLowerCase()}\n\n👉 Review in Hermes: ${config.frontend.url}/pending-approvals`;
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
    const slackMsg = `📢 *Hermes Access Update*\n--------------------------\nAccess request to *${escapeSlackText(groupName)}* was *${statusText}* by ${escapeSlackText(reviewerName)}.${note ? `\nNote: "${escapeSlackText(note)}"` : ''}`;
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

    const slackMsg = `⏳ *Hermes Access Expired*\n--------------------------\nAccess to *${escapeSlackText(groupName)}* group has expired for User ID: ${escapeSlackText(userId)}`;
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

    const slackMsg = `🚫 *Hermes Access Revoked*\n--------------------------\nAccess to *${escapeSlackText(groupName)}* group was revoked by ${escapeSlackText(revokerName)} for User ID: ${escapeSlackText(userId)}.${reason ? `\nReason: "${escapeSlackText(reason)}"` : ''}`;
    await slackService.sendPing(slackMsg);
  }

  // Group request approved but the requester hasn't finished Redash setup yet — queued.
  async notifyAccessQueuedForSetup(
    requesterId: string,
    groupName: string,
    reviewerName: string,
  ): Promise<void> {
    await this.createNotification(
      requesterId,
      'Access queued',
      `${reviewerName} approved your request to ${groupName}. It will activate once you finish setting up your Redash account.`,
      '/account-status',
    );
  }

  // Slack-flavoured mention of a user that linkifies their email in the channel.
  private formatUserMention(email: string): string {
    return `<mailto:${email}|${email}>`;
  }

  // User submitted a user-creation request → notify all super-admins.
  async notifyUserCreationSubmitted(
    requestId: string,
    userName: string,
    userEmail: string,
    justification: string | null,
  ): Promise<void> {
    const slackMsg = `🆕 *Hermes — New User Creation Request*\n--------------------------\n*${escapeSlackText(userName)}* (${escapeSlackText(userEmail)}) wants a Hermes/Redash account.\n${justification ? `Reason: "${escapeSlackText(justification)}"\n` : ''}\n👉 Review: ${config.frontend.url}/pending-approvals`;
    await slackService.sendPing(slackMsg);

    try {
      // Super-admins are the only ones who can approve user-creation. Look them
      // up directly via Keycloak (or the sim super-admin UUID in dev). Then also
      // fan out to every distinct GroupAdmin so they see new-user signups
      // without needing approval rights.
      const [superAdminIds, groupAdmins] = await Promise.all([
        keycloakSetupService.getSuperAdminUserIds(),
        prisma.groupAdmin.findMany({ distinct: ['userId'] }),
      ]);

      const seen = new Set<string>();
      const fanOut = async (userId: string) => {
        if (seen.has(userId)) return;
        seen.add(userId);
        await this.createNotification(
          userId,
          'Pending user approval',
          `${userName} requested a Hermes account.`,
          `/pending-approvals`,
        );
      };

      for (const userId of superAdminIds) await fanOut(userId);
      for (const admin of groupAdmins) await fanOut(admin.userId);

      if (seen.size === 0) {
        logger.warn(
          { requestId },
          'notifyUserCreationSubmitted: no super-admins or group-admins to notify',
        );
      }
    } catch (err: any) {
      logger.error('Failed to fan out user-creation.submitted notifications:', err.message);
    }
  }

  // Admin approved a user-creation request → tell the user (Redash will email them separately).
  async notifyUserCreationApproved(
    requesterId: string,
    userEmail: string,
    reviewerName: string,
  ): Promise<void> {
    await this.createNotification(
      requesterId,
      'Your account is approved',
      `${reviewerName} approved your Hermes account. Check your email — Redash has sent you a link to set your password.`,
      '/account-status',
    );

    const slackMsg = `✅ *Hermes — Account Approved*\n--------------------------\n${this.formatUserMention(userEmail)} your Hermes account is ready! Check your inbox for the Redash setup email.\n\n👉 ${config.frontend.url}/account-status`;
    await slackService.sendPing(slackMsg);
  }

  async notifyUserCreationRejected(
    requesterId: string,
    reviewerName: string,
    note?: string,
  ): Promise<void> {
    await this.createNotification(
      requesterId,
      'Account request rejected',
      `${reviewerName} declined your Hermes account request.${note ? ` Reason: "${note}"` : ''}`,
      '/account-status',
    );
  }

  async notifyUserCreationCompleted(
    requesterId: string,
    userEmail: string,
  ): Promise<void> {
    await this.createNotification(
      requesterId,
      'Account setup complete',
      'You are now fully set up on Redash. Any group requests already approved by admin have been provisioned.',
      '/',
    );

    const slackMsg = `🎉 *Hermes — Account Setup Complete*\n--------------------------\n${this.formatUserMention(userEmail)} has finished Redash setup and any pending group memberships have been provisioned.`;
    await slackService.sendPing(slackMsg);
  }
}

export const notificationService = new NotificationService();
export default notificationService;
