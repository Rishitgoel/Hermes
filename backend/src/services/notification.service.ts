import prisma from '../config/prisma';
import slackService from './slack.service';
import emailService from './email.service';
import logger from '../utils/logger';
import config from '../config/config';
import provisioningRegistry from './provisioning.registry';
import keycloakSetupService from '../config/keycloak-setup';
import * as templates from '../utils/email-templates';
import type { EmailContent } from '../utils/email-templates';

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

/** "THREE_MONTHS" → "three months". Global flag so multi-underscore values
 *  render consistently with the email templates (which use /_/g). */
function formatDuration(duration: string): string {
  return duration.replace(/_/g, ' ').toLowerCase();
}

interface AdminRecipient {
  userId: string;
  email?: string | null;
}

interface InAppContent {
  title: string;
  message: string;
  link: string;
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

  /**
   * Send a personal email + Slack DM to one person, both keyed on their email.
   * No-ops cleanly if the address is missing. Each channel fails silently inside
   * its own service, so one bad send never blocks the other.
   */
  private async emailAndDm(
    email: string | undefined | null,
    content: EmailContent,
    slackText: string,
  ): Promise<void> {
    if (!email) return;
    // Run both channels concurrently and independently — each already fails
    // silently inside its own service, and allSettled guarantees one channel's
    // failure can never skip the other.
    await Promise.allSettled([
      emailService.sendEmail({
        to: email,
        subject: content.subject,
        html: content.html,
        text: content.text,
      }),
      slackService.sendDirectMessage(email, slackText),
    ]);
  }

  /**
   * Notify a set of admins on all three channels (in-app + email + Slack DM),
   * de-duplicated by userId so a person holding multiple admin roles is notified
   * once. Returns the count of distinct people notified. Single home for the
   * "fan out to admins" pattern used by both the group-request and
   * account-request notifications.
   */
  private async fanOutToAdmins(
    recipients: AdminRecipient[],
    inApp: InAppContent,
    email: EmailContent,
    dm: string,
  ): Promise<number> {
    const seen = new Set<string>();
    for (const r of recipients) {
      if (seen.has(r.userId)) continue;
      seen.add(r.userId);
      await this.createNotification(r.userId, inApp.title, inApp.message, inApp.link);
      await this.emailAndDm(r.email, email, dm);
    }
    return seen.size;
  }

  // User requests access -> notify Group + Platform admins (in-app + email + Slack DM) + team channel ping
  async notifyRequestCreated(
    requestId: string,
    groupId: string,
    groupName: string,
    requesterName: string,
    justification: string,
    duration: string
  ): Promise<void> {
    // 1. Team channel ping (optional shared feed)
    const slackMsg = `📋 *Hermes Access Request*\n--------------------------\n*${escapeSlackText(requesterName)}* requested access to the *${escapeSlackText(groupName)}* group.\nReason: "${escapeSlackText(justification)}"\nDuration: ${formatDuration(duration)}\n\n👉 Review in Hermes: ${config.frontend.url}/pending-approvals`;
    await slackService.sendPing(slackMsg);

    // 2. Notify everyone who can act on this request: the group's own admins AND
    //    the platform admins of the group's platform (a platform admin can
    //    approve any group on their platform — see authz.isGroupAdminOf).
    //    If neither exists for this group, fall back to super admins so a pending
    //    request is never left with nobody notified to action it.
    try {
      const group = await prisma.group.findUnique({
        where: { id: groupId },
        select: { platform: true },
      });

      const [groupAdmins, platformAdmins] = await Promise.all([
        prisma.groupAdmin.findMany({ where: { groupId } }),
        group?.platform
          ? prisma.platformAdmin.findMany({ where: { platform: group.platform } })
          : Promise.resolve([] as { userId: string; userEmail: string }[]),
      ]);

      let recipients: AdminRecipient[] = [
        ...groupAdmins.map((a) => ({ userId: a.userId, email: a.userEmail })),
        ...platformAdmins.map((a) => ({ userId: a.userId, email: a.userEmail })),
      ];
      if (recipients.length === 0) {
        const supers = await keycloakSetupService.getSuperAdmins();
        recipients = supers.map((s) => ({ userId: s.id, email: s.email }));
      }

      const email = templates.adminNewGroupRequest({ requesterName, groupName, justification, duration });
      const dm = `📋 *${escapeSlackText(requesterName)}* requested access to *${escapeSlackText(groupName)}* (${formatDuration(duration)}).\nReason: "${escapeSlackText(justification)}"\n👉 ${config.frontend.url}/pending-approvals`;

      const notified = await this.fanOutToAdmins(
        recipients,
        {
          title: 'Pending Approval Request',
          message: `${requesterName} requested access to ${groupName}.`,
          link: '/pending-approvals',
        },
        email,
        dm,
      );
      if (notified === 0) {
        logger.warn({ groupId }, 'notifyRequestCreated: no admins resolved to notify');
      }
    } catch (error: any) {
      logger.error('Failed to notify group/platform admins:', error.message);
    }
  }

  // Request is approved/rejected -> notify requester (in-app + email + Slack DM)
  async notifyRequestReviewed(
    requesterId: string,
    groupName: string,
    approved: boolean,
    reviewerName: string,
    note?: string,
    requesterEmail?: string,
  ): Promise<void> {
    const statusText = approved ? 'APPROVED' : 'REJECTED';
    const title = `Access Request ${statusText}`;
    const message = approved
      ? `Your access request to ${groupName} was approved by ${reviewerName}.${note ? ` Note: "${note}"` : ''}`
      : `Your access request to ${groupName} was rejected by ${reviewerName}.${note ? ` Reason: "${note}"` : ''}`;

    await this.createNotification(requesterId, title, message, approved ? '/' : '/my-requests');

    // Personal email + Slack DM to the requester.
    const email = approved
      ? templates.userGroupApproved({ groupName, reviewerName, note })
      : templates.userGroupRejected({ groupName, reviewerName, note });
    const dm = `📢 Access request to *${escapeSlackText(groupName)}* was *${statusText}* by ${escapeSlackText(reviewerName)}.${note ? `\nNote: "${escapeSlackText(note)}"` : ''}`;
    await this.emailAndDm(requesterEmail, email, dm);
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

  // Auto-expiry permanently failed after retries — alert super admins + the platform
  // admins for *that* platform that the grant was forced inactive and the user may
  // still need manual cleanup on the platform.
  async notifyExpiryFailed(
    userAccessId: string,
    userName: string,
    groupName: string,
    attempts: number,
    error: string,
    platform: string,
  ): Promise<void> {
    const slackMsg = `⚠️ *Hermes — Auto-expiry failed*\n--------------------------\nCould not remove *${escapeSlackText(userName)}* from *${escapeSlackText(groupName)}* after ${attempts} attempts.\nThe grant was force-marked inactive in Hermes, but the user may still exist on the platform — manual cleanup may be required.\nError: "${escapeSlackText(error)}"`;
    await slackService.sendPing(slackMsg);

    try {
      const [superAdmins, platformAdmins] = await Promise.all([
        keycloakSetupService.getSuperAdmins(),
        prisma.platformAdmin.findMany({ where: { platform: platform.toLowerCase() }, distinct: ['userId'] }),
      ]);

      const recipients = [
        ...superAdmins.map((a) => a.id),
        ...platformAdmins.map((a) => a.userId),
      ];

      const seen = new Set<string>();
      for (const userId of recipients) {
        if (seen.has(userId)) continue;
        seen.add(userId);
        await this.createNotification(
          userId,
          'Auto-expiry failed',
          `Could not remove ${userName} from ${groupName} after ${attempts} attempts. The grant was forced inactive — manual platform cleanup may be required.`,
          '/audit-log',
        );
      }
      if (seen.size === 0) {
        logger.warn({ userAccessId }, 'notifyExpiryFailed: no admins to notify');
      }
    } catch (err: any) {
      logger.error('Failed to fan out access.expiry-failed notifications:', err.message);
    }
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

  /** Human-friendly platform name for user-facing copy. */
  private platformLabel(platform?: string): string {
    const key = (platform || config.platform.default).toLowerCase();
    // Display name is adapter-owned (PlatformAdapter.displayName) — no per-platform
    // branching here, so a new adapter's name flows through automatically. Fall back
    // to a title-cased key for an unregistered platform.
    if (provisioningRegistry.has(key)) return provisioningRegistry.get(key).displayName;
    return key.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Group request approved but the requester hasn't finished platform setup yet — queued.
  async notifyAccessQueuedForSetup(
    requesterId: string,
    groupName: string,
    reviewerName: string,
    platform?: string,
  ): Promise<void> {
    const label = this.platformLabel(platform);
    await this.createNotification(
      requesterId,
      'Access queued',
      `${reviewerName} approved your request to ${groupName}. It will activate once you finish setting up your ${label} account.`,
      '/my-requests',
    );
  }

  // User submitted a user-creation request → notify all super-admins.
  async notifyUserCreationSubmitted(
    requestId: string,
    userName: string,
    userEmail: string,
    justification: string | null,
    platform?: string,
  ): Promise<void> {
    const label = this.platformLabel(platform);
    const slackMsg = `🆕 *Hermes — New User Creation Request*\n--------------------------\n*${escapeSlackText(userName)}* (${escapeSlackText(userEmail)}) wants a ${label} account.\n${justification ? `Reason: "${escapeSlackText(justification)}"\n` : ''}\n👉 Review: ${config.frontend.url}/pending-approvals`;
    await slackService.sendPing(slackMsg);

    try {
      // Super-admins are the only ones who can approve user-creation. Look them
      // up directly via Keycloak (or the sim super-admin in dev). Then also
      // fan out to every distinct Platform/Group admin so the lower tiers see
      // new-user signups without needing approval rights.
      const [superAdmins, platformAdmins, groupAdmins] = await Promise.all([
        keycloakSetupService.getSuperAdmins(),
        prisma.platformAdmin.findMany({ distinct: ['userId'] }),
        prisma.groupAdmin.findMany({ distinct: ['userId'] }),
      ]);

      const emailContent = templates.adminNewAccountRequest({ userName, userEmail, justification, platformLabel: label });
      const dm = `🆕 *${escapeSlackText(userName)}* (${escapeSlackText(userEmail)}) requested a ${label} account.\n${justification ? `Reason: "${escapeSlackText(justification)}"\n` : ''}👉 ${config.frontend.url}/pending-approvals`;

      const recipients: AdminRecipient[] = [
        ...superAdmins.map((a) => ({ userId: a.id, email: a.email })),
        ...platformAdmins.map((a) => ({ userId: a.userId, email: a.userEmail })),
        ...groupAdmins.map((a) => ({ userId: a.userId, email: a.userEmail })),
      ];

      const notified = await this.fanOutToAdmins(
        recipients,
        {
          title: 'Pending user approval',
          message: `${userName} requested a ${label} account.`,
          link: '/pending-approvals',
        },
        emailContent,
        dm,
      );
      if (notified === 0) {
        logger.warn({ requestId }, 'notifyUserCreationSubmitted: no admins to notify');
      }
    } catch (err: any) {
      logger.error('Failed to fan out user-creation.submitted notifications:', err.message);
    }
  }

  // Admin approved a user-creation request that needs the user to finish setup via a
  // platform-issued link → tell the user (the platform emails the link separately).
  async notifyUserCreationApproved(
    requesterId: string,
    userEmail: string,
    reviewerName: string,
    platform?: string,
  ): Promise<void> {
    const label = this.platformLabel(platform);
    await this.createNotification(
      requesterId,
      'Your account is approved',
      `${reviewerName} approved your Hermes account. Check your email — ${label} has sent you a link to set your password.`,
      '/my-requests',
    );

    const dm = `✅ Your Hermes account is approved by ${escapeSlackText(reviewerName)}! Check your inbox for the ${escapeSlackText(label)} setup email.\n👉 ${config.frontend.url}/my-requests`;
    await this.emailAndDm(userEmail, templates.userAccountApproved({ reviewerName, platformLabel: label }), dm);
  }

  async notifyUserCreationRejected(
    requesterId: string,
    reviewerName: string,
    note?: string,
    userEmail?: string,
  ): Promise<void> {
    await this.createNotification(
      requesterId,
      'Account request rejected',
      `${reviewerName} declined your Hermes account request.${note ? ` Reason: "${note}"` : ''}`,
      '/my-requests',
    );

    const dm = `❌ Your Hermes account request was declined by ${escapeSlackText(reviewerName)}.${note ? `\nReason: "${escapeSlackText(note)}"` : ''}`;
    await this.emailAndDm(userEmail, templates.userAccountRejected({ reviewerName, note }), dm);
  }

  async notifyUserCreationCompleted(
    requesterId: string,
    userEmail: string,
    platform: string = config.platform.default,
  ): Promise<void> {
    // Onboarding copy is platform-specific (Redash: "you're set up"; AWS: "set your
    // password via the access portal"). Each adapter owns its own message via
    // getOnboardingMessage(), so this stays platform-agnostic — a new platform just
    // supplies that method and needs no change here.
    const adapter = provisioningRegistry.has(platform) ? provisioningRegistry.get(platform) : null;
    const onboarding = adapter?.getOnboardingMessage?.();

    if (onboarding) {
      await this.createNotification(
        requesterId,
        onboarding.notification.title,
        onboarding.notification.message,
        onboarding.notification.link ?? '/my-requests',
      );
      await this.emailAndDm(userEmail, onboarding.email, onboarding.dm);
      return;
    }

    // Generic fallback for an adapter that doesn't customise onboarding.
    const label = this.platformLabel(platform);
    await this.createNotification(
      requesterId,
      'Account setup complete',
      `Your ${label} account is fully set up. Any group requests already approved by an admin have been provisioned.`,
      '/',
    );
    await this.emailAndDm(
      userEmail,
      templates.userAccountSetupComplete({ platformLabel: label }),
      `🎉 Your ${label} account is fully set up — any approved group memberships have been provisioned.\n👉 ${config.frontend.url}/`,
    );
  }
}

export const notificationService = new NotificationService();
export default notificationService;
