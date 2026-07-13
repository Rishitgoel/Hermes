import prisma from '../config/prisma';
import eventBus from './event-bus';
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
      const created = await prisma.notification.create({
        data: {
          userId,
          title,
          message,
          linkUrl,
        },
      });
      logger.info(`🔔 In-app notification created for user ${userId}: "${title}"`);

      // Push it to any open SSE stream for this user (P2-6, replaces 60s polling).
      // Best-effort: a stream-delivery problem must never fail the DB write above.
      eventBus.emitNotificationCreated({
        userId,
        notification: {
          id: created.id,
          userId: created.userId,
          title: created.title,
          message: created.message,
          linkUrl: created.linkUrl,
          isRead: created.isRead,
          createdAt: created.createdAt,
        },
      });
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
    const unique = recipients.filter((r) => {
      if (seen.has(r.userId)) return false;
      seen.add(r.userId);
      return true;
    });
    // Notify recipients concurrently — each channel already fails silently inside
    // its own service, and allSettled guarantees one admin's failure can never
    // skip another's notification (serial delivery made many-admin fan-outs drag).
    await Promise.allSettled(
      unique.map(async (r) => {
        await this.createNotification(r.userId, inApp.title, inApp.message, inApp.link);
        await this.emailAndDm(r.email, email, dm);
      }),
    );
    return unique.length;
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

  /**
   * Bulk variant of notifyRequestCreated: one team-channel ping for the whole batch,
   * then ONE summary per admin (in-app + email + Slack DM) instead of N pings. Each
   * admin is told only about the groups in this batch they can actually review; an
   * item with no group/platform admin falls back to super admins (resolved once).
   */
  async notifyRequestsCreatedBulk(
    requesterName: string,
    duration: string,
    items: { requestId: string; groupId: string; groupName: string; levelName: string | null }[],
  ): Promise<void> {
    if (!items || items.length === 0) return;

    const labelFor = (i: { groupName: string; levelName: string | null }) =>
      i.levelName ? `${i.groupName} — ${i.levelName}` : i.groupName;

    // 1. One team-channel ping for the whole batch.
    const allLabels = items.map(labelFor);
    const slackMsg = `📋 *Hermes Access Requests*\n--------------------------\n*${escapeSlackText(requesterName)}* requested access to ${items.length} group(s): ${allLabels.map(escapeSlackText).join(', ')}.\nDuration: ${formatDuration(duration)}\n\n👉 Review in Hermes: ${config.frontend.url}/pending-approvals`;
    await slackService.sendPing(slackMsg);

    // 2. Fan out to the admins who can action these groups — one summary per admin.
    try {
      const groupIds = [...new Set(items.map((i) => i.groupId))];
      const groups = await prisma.group.findMany({
        where: { id: { in: groupIds } },
        select: { id: true, platform: true },
      });
      const platformByGroup = new Map(groups.map((g) => [g.id, g.platform]));
      const platforms = [...new Set(groups.map((g) => g.platform).filter(Boolean))] as string[];

      const [groupAdmins, platformAdmins] = await Promise.all([
        prisma.groupAdmin.findMany({ where: { groupId: { in: groupIds } } }),
        platforms.length > 0
          ? prisma.platformAdmin.findMany({ where: { platform: { in: platforms } } })
          : Promise.resolve([] as { userId: string; userEmail: string; platform: string }[]),
      ]);

      // adminUserId -> { email, set of group labels they can review in this batch }
      const recipients = new Map<string, { email?: string | null; labels: Set<string> }>();
      const addRecipient = (userId: string, email: string | null | undefined, label: string) => {
        const entry = recipients.get(userId) ?? { email, labels: new Set<string>() };
        if (!entry.email && email) entry.email = email;
        entry.labels.add(label);
        recipients.set(userId, entry);
      };

      let supers: Awaited<ReturnType<typeof keycloakSetupService.getSuperAdmins>> | null = null;
      for (const item of items) {
        const label = labelFor(item);
        const platform = platformByGroup.get(item.groupId);
        const ga = groupAdmins.filter((a) => a.groupId === item.groupId);
        const pa = platform ? platformAdmins.filter((a) => a.platform === platform) : [];
        if (ga.length === 0 && pa.length === 0) {
          // Nobody scoped to this group → fall back to super admins (fetched once).
          if (!supers) supers = await keycloakSetupService.getSuperAdmins();
          supers.forEach((s) => addRecipient(s.id, s.email, label));
        } else {
          ga.forEach((a) => addRecipient(a.userId, a.userEmail, label));
          pa.forEach((a) => addRecipient(a.userId, a.userEmail, label));
        }
      }

      await Promise.allSettled(
        [...recipients.entries()].map(async ([userId, info]) => {
          const labels = [...info.labels];
          await this.createNotification(
            userId,
            'Pending Approval Requests',
            `${requesterName} requested access to ${labels.length} group(s): ${labels.join(', ')}.`,
            '/pending-approvals',
          );
          const email = templates.adminNewGroupRequestsBulk({ requesterName, groupLabels: labels, duration });
          const dm = `📋 *${escapeSlackText(requesterName)}* requested access to ${labels.length} group(s): ${labels.map(escapeSlackText).join(', ')} (${formatDuration(duration)}).\n👉 ${config.frontend.url}/pending-approvals`;
          await this.emailAndDm(info.email, email, dm);
        }),
      );

      if (recipients.size === 0) {
        logger.warn('notifyRequestsCreatedBulk: no admins resolved to notify');
      }
    } catch (error: any) {
      logger.error('Failed to fan out bulk request notifications:', error.message);
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

  // ── ZooKeeper config change requests ────────────────────────────────────────────

  /**
   * A user proposed ZooKeeper config change(s) → notify the admins of EVERY involved group
   * + the ZooKeeper platform admins (fall back to super admins). One request can span
   * several groups; any involved admin can review it.
   */
  async notifyZkChangeRequestCreated(
    requestId: string,
    groupIds: string[],
    groupNames: string[],
    requesterName: string,
    justification: string | null,
    changeCount: number = 0,
  ): Promise<void> {
    const groupLabel = groupNames.join(', ') || 'ZooKeeper';
    const slackMsg = `🔧 *Hermes — ZooKeeper Config Change*\n--------------------------\n*${escapeSlackText(requesterName)}* proposed ${changeCount} config change(s) for *${escapeSlackText(groupLabel)}*.${justification ? `\nReason: "${escapeSlackText(justification)}"` : ''}\n\n👉 Review in Hermes: ${config.frontend.url}/pending-approvals`;
    await slackService.sendPing(slackMsg);

    try {
      const [groupAdmins, platformAdmins] = await Promise.all([
        groupIds.length > 0
          ? prisma.groupAdmin.findMany({ where: { groupId: { in: groupIds } } })
          : Promise.resolve([] as { userId: string; userEmail: string }[]),
        prisma.platformAdmin.findMany({ where: { platform: 'zookeeper' } }),
      ]);

      let recipients: AdminRecipient[] = [
        ...groupAdmins.map((a) => ({ userId: a.userId, email: a.userEmail })),
        ...platformAdmins.map((a) => ({ userId: a.userId, email: a.userEmail })),
      ];
      if (recipients.length === 0) {
        const supers = await keycloakSetupService.getSuperAdmins();
        recipients = supers.map((s) => ({ userId: s.id, email: s.email }));
      }

      const email = templates.adminZkChangeRequest({ requesterName, groupName: groupLabel, changeCount, justification });
      const dm = `🔧 *${escapeSlackText(requesterName)}* proposed ${changeCount} ZooKeeper config change(s) for *${escapeSlackText(groupLabel)}*.${justification ? `\nReason: "${escapeSlackText(justification)}"` : ''}\n👉 ${config.frontend.url}/pending-approvals`;

      const notified = await this.fanOutToAdmins(
        recipients,
        {
          title: 'ZooKeeper config change request',
          message: `${requesterName} proposed ${changeCount} config change(s) for ${groupLabel}.`,
          link: '/pending-approvals',
        },
        email,
        dm,
      );
      if (notified === 0) {
        logger.warn({ requestId }, 'notifyZkChangeRequestCreated: no admins resolved to notify');
      }
    } catch (error: any) {
      logger.error('Failed to notify ZooKeeper change-request admins:', error.message);
    }
  }

  /** A ZooKeeper config change request was reviewed (per-change) → notify the requester
   *  with the approved/rejected breakdown. */
  async notifyZkChangeRequestReviewed(
    requesterId: string,
    requesterEmail: string | undefined,
    groupNames: string[],
    status: 'APPLIED' | 'PARTIALLY_APPLIED' | 'APPLY_FAILED' | 'REJECTED',
    reviewerName: string,
    note?: string,
    approved: number = 0,
    rejected: number = 0,
  ): Promise<void> {
    const groupLabel = (groupNames || []).join(', ') || 'ZooKeeper';
    const summary: Record<typeof status, string> = {
      APPLIED: `all ${approved} change(s) were approved and applied`,
      PARTIALLY_APPLIED: `${approved} change(s) approved & applied, ${rejected} rejected`,
      APPLY_FAILED: `${approved} change(s) approved but one or more failed to apply — an admin will follow up`,
      REJECTED: `your change(s) were rejected`,
    };
    const line = summary[status];
    const title = status === 'REJECTED' ? 'ZooKeeper change rejected' : 'ZooKeeper change reviewed';

    await this.createNotification(
      requesterId,
      title,
      `Your ZooKeeper config request for ${groupLabel} was reviewed by ${reviewerName}: ${line}.${note ? ` Note: "${note}"` : ''}`,
      '/zookeeper',
    );

    const email = templates.userZkChangeReviewed({ groupName: groupLabel, status, reviewerName, note, approved, rejected });
    const dm = `🔧 Your ZooKeeper config request for *${escapeSlackText(groupLabel)}* was reviewed by ${escapeSlackText(reviewerName)}: ${escapeSlackText(line)}.${note ? `\nNote: "${escapeSlackText(note)}"` : ''}`;
    await this.emailAndDm(requesterEmail, email, dm);
  }

  /**
   * A user proposed a Secret Ingestion request → notify group admins and platform 'secrets' admins.
   */
  async notifySecretIngestionSubmitted(
    requestId: string,
    groupId: string | null,
    groupName: string,
    secretName: string,
    requesterName: string,
    justification: string | null,
    keyCount: number = 0,
    platform: string = 'secrets',
  ): Promise<void> {
    const slackMsg = `🔑 *Hermes — Secret Ingestion Request*\n--------------------------\n*${escapeSlackText(requesterName)}* proposed ${keyCount} secret key(s) ingestion for *${escapeSlackText(secretName)}* (Group: *${escapeSlackText(groupName)}*).${justification ? `\nReason: "${escapeSlackText(justification)}"` : ''}\n\n👉 Review in Hermes: ${config.frontend.url}/pending-approvals`;
    await slackService.sendPing(slackMsg);

    // Resolve recipients (group/platform admins) and the super-admin fallback as
    // two INDEPENDENT steps: a failure resolving group/platform admins must not
    // skip the fallback, or a transient query error would notify no one at all.
    let recipients: AdminRecipient[] = [];
    try {
      const [groupAdmins, platformAdmins] = await Promise.all([
        groupId
          ? prisma.groupAdmin.findMany({ where: { groupId } })
          : Promise.resolve([] as { userId: string; userEmail: string }[]),
        prisma.platformAdmin.findMany({ where: { platform } }),
      ]);
      recipients = [
        ...groupAdmins.map((a) => ({ userId: a.userId, email: a.userEmail })),
        ...platformAdmins.map((a) => ({ userId: a.userId, email: a.userEmail })),
      ];
    } catch (error: any) {
      logger.error(
        { requestId, error: error.message },
        'Failed to resolve group/platform admins for Secret Ingestion notification — falling back to super admins',
      );
    }

    if (recipients.length === 0) {
      try {
        const supers = await keycloakSetupService.getSuperAdmins();
        recipients = supers.map((s) => ({ userId: s.id, email: s.email }));
      } catch (error: any) {
        logger.error(
          { requestId, error: error.message },
          'Failed to resolve super admins for Secret Ingestion notification fallback',
        );
      }
    }

    try {
      const email = templates.adminSecretIngestionRequest({ requesterName, groupName, secretName, keyCount, justification });
      const dm = `🔑 *${escapeSlackText(requesterName)}* proposed ${keyCount} secret key(s) ingestion for *${escapeSlackText(secretName)}* (Group: *${escapeSlackText(groupName)}*).${justification ? `\nReason: "${escapeSlackText(justification)}"` : ''}\n👉 ${config.frontend.url}/pending-approvals`;

      const notified = await this.fanOutToAdmins(
        recipients,
        {
          title: 'Secret Ingestion request',
          message: `${requesterName} proposed ${keyCount} key(s) for ${secretName}.`,
          link: '/pending-approvals',
        },
        email,
        dm,
      );
      if (notified === 0) {
        logger.warn({ requestId }, 'notifySecretIngestionSubmitted: no admins resolved to notify');
      }
    } catch (error: any) {
      logger.error('Failed to notify Secret Ingestion admins:', error.message);
    }
  }

  /**
   * A Secret Ingestion request was reviewed → notify the requester.
   */
  async notifySecretIngestionReviewed(
    requestId: string,
    secretName: string,
    status: 'APPLIED' | 'PARTIALLY_APPLIED' | 'APPLY_FAILED' | 'REJECTED',
    reviewerName: string,
    approvedCount: number = 0,
    rejectedCount: number = 0,
    failedCount: number = 0,
  ): Promise<void> {
    const row = await prisma.secretIngestionRequest.findUnique({
      where: { id: requestId },
      select: { requesterId: true, requesterEmail: true, reviewNote: true }
    });
    if (!row) {
      logger.warn({ requestId }, 'notifySecretIngestionReviewed: request not found');
      return;
    }

    const summary: Record<typeof status, string> = {
      APPLIED: `all ${approvedCount} secret(s) were approved and ingested`,
      PARTIALLY_APPLIED: `${approvedCount} secret(s) approved & ingested, ${rejectedCount} rejected`,
      APPLY_FAILED: `${approvedCount} secret(s) approved but ${failedCount} failed to ingest — an admin will follow up`,
      REJECTED: `your secret ingestion request was rejected`,
    };
    const line = summary[status];
    const title = status === 'REJECTED' ? 'Secret Ingestion request rejected' : 'Secret Ingestion request reviewed';

    await this.createNotification(
      row.requesterId,
      title,
      `Your Secret Ingestion request for ${secretName} was reviewed by ${reviewerName}: ${line}.${row.reviewNote ? ` Note: "${row.reviewNote}"` : ''}`,
      '/secrets',
    );

    const email = templates.userSecretIngestionReviewed({ secretName, status, reviewerName, note: row.reviewNote || undefined, approved: approvedCount, rejected: rejectedCount, failed: failedCount });
    const dm = `🔑 Your Secret Ingestion request for *${escapeSlackText(secretName)}* was reviewed by ${escapeSlackText(reviewerName)}: ${escapeSlackText(line)}.${row.reviewNote ? `\nNote: "${escapeSlackText(row.reviewNote)}"` : ''}`;
    await this.emailAndDm(row.requesterEmail, email, dm);
  }

  /**
   * The scheduled drift scan found secrets whose AWS key set has drifted from the
   * infra-deployment manifests → notify the platform's admins (super + platform admins) on all
   * three channels. `drifts` are only the NEWLY-drifting secrets (the caller dedupes against
   * what's already been alerted), so this fires once per genuinely-new drift, not every scan.
   */
  async notifySecretDriftDetected(
    platform: string,
    drifts: {
      secretName: string;
      missingInManifest: string[];
      missingInAws: string[];
      fixable: boolean;
    }[],
  ): Promise<void> {
    if (drifts.length === 0) return;

    const fixableCount = drifts.filter((d) => d.fixable).length;
    const names = drifts.map((d) => d.secretName);
    const preview = names.slice(0, 5).join(', ') + (names.length > 5 ? `, +${names.length - 5} more` : '');

    const slackMsg = `⚠️ *Hermes — Secret Drift Detected*\n--------------------------\n${drifts.length} secret(s) on *${escapeSlackText(platform)}* have drifted between AWS Secrets Manager and infra-deployment: ${escapeSlackText(preview)}.${fixableCount > 0 ? `\n${fixableCount} can be reconciled with one click.` : ''}\n\n👉 Review in Hermes: ${config.frontend.url}/pending-approvals`;
    await slackService.sendPing(slackMsg);

    let recipients: AdminRecipient[] = [];
    try {
      const platformAdmins = await prisma.platformAdmin.findMany({
        where: { platform },
        distinct: ['userId'],
      });
      recipients = platformAdmins.map((a) => ({ userId: a.userId, email: a.userEmail }));
    } catch (error: any) {
      logger.error({ platform, error: error.message }, 'Failed to resolve platform admins for drift notification');
    }
    // Super admins are always included — drift is an account-wide ops concern, and they're the
    // fallback when a platform has no dedicated platform admin.
    try {
      const supers = await keycloakSetupService.getSuperAdmins();
      recipients = [...recipients, ...supers.map((s) => ({ userId: s.id, email: s.email }))];
    } catch (error: any) {
      logger.error({ platform, error: error.message }, 'Failed to resolve super admins for drift notification');
    }
    if (recipients.length === 0) {
      logger.warn({ platform }, 'notifySecretDriftDetected: no admins resolved to notify');
      return;
    }

    const listHtml = drifts
      .map((d) => {
        const bits: string[] = [];
        if (d.missingInManifest.length > 0) bits.push(`${d.missingInManifest.length} key(s) not registered in manifests`);
        if (d.missingInAws.length > 0) bits.push(`${d.missingInAws.length} manifest key(s) missing from AWS`);
        return `<li><code>${d.secretName}</code> — ${bits.join('; ') || 'drift'}</li>`;
      })
      .join('');
    const email: EmailContent = {
      subject: `Hermes: ${drifts.length} secret(s) drifted on ${platform}`,
      html:
        `<p>${drifts.length} secret(s) on <strong>${platform}</strong> have drifted between AWS Secrets Manager and the infra-deployment manifests:</p>` +
        `<ul>${listHtml}</ul>` +
        (fixableCount > 0
          ? `<p>${fixableCount} can be reconciled from the <a href="${config.frontend.url}/pending-approvals">Pending Approvals</a> page — the "Solve drift" button opens a draft PR registering the missing keys.</p>`
          : `<p>Review them on the <a href="${config.frontend.url}/pending-approvals">Pending Approvals</a> page.</p>`),
      text:
        `${drifts.length} secret(s) on ${platform} have drifted between AWS Secrets Manager and infra-deployment: ${names.join(', ')}. ` +
        `Review at ${config.frontend.url}/pending-approvals`,
    };
    const dm = `⚠️ ${drifts.length} secret(s) on *${escapeSlackText(platform)}* drifted between AWS and infra-deployment: ${escapeSlackText(preview)}.${fixableCount > 0 ? ` ${fixableCount} can be reconciled with one click.` : ''}\n👉 ${config.frontend.url}/pending-approvals`;

    try {
      await this.fanOutToAdmins(
        recipients,
        {
          title: 'Secret drift detected',
          message: `${drifts.length} secret(s) on ${platform} drifted from infra-deployment${fixableCount > 0 ? ` — ${fixableCount} reconcilable` : ''}.`,
          link: '/pending-approvals',
        },
        email,
        dm,
      );
    } catch (error: any) {
      logger.error({ platform, error: error.message }, 'Failed to notify admins of secret drift');
    }
  }

  // Access is auto-expired
  async notifyAccessExpired(
    userId: string,
    groupName: string,
    userEmail?: string,
  ): Promise<void> {
    const title = 'Access Expired';
    const message = `Your temporary access to ${groupName} group has expired.`;

    await this.createNotification(userId, title, message, '/groups');

    const slackMsg = `⏳ *Hermes Access Expired*\n--------------------------\nAccess to *${escapeSlackText(groupName)}* group has expired for User ID: ${escapeSlackText(userId)}`;
    await slackService.sendPing(slackMsg);

    const dm = `⏳ Your access to *${escapeSlackText(groupName)}* has expired.\n👉 ${config.frontend.url}/groups`;
    await this.emailAndDm(userEmail, templates.userAccessExpired({ groupName }), dm);
  }

  // Pre-expiry heads-up — sent once per grant by the scheduler's warning sweep,
  // ahead of the actual auto-revoke in notifyAccessExpired.
  async notifyAccessExpiringSoon(
    userId: string,
    groupName: string,
    userEmail: string | undefined,
    expiresAt: Date | string,
  ): Promise<void> {
    const expiresAtDate = new Date(expiresAt);
    const title = 'Access Expiring Soon';
    const message = `Your access to ${groupName} group expires on ${expiresAtDate.toLocaleDateString()}.`;

    await this.createNotification(userId, title, message, '/groups');

    const dm = `⏳ Your access to *${escapeSlackText(groupName)}* expires on ${expiresAtDate.toLocaleDateString()}. Request a renewal if you still need it.\n👉 ${config.frontend.url}/groups`;
    await this.emailAndDm(userEmail, templates.userAccessExpiringSoon({ groupName, expiresAt: expiresAtDate }), dm);
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
    reason?: string,
    userEmail?: string,
  ): Promise<void> {
    const title = 'Access Revoked';
    const message = `Your access to ${groupName} group was revoked by ${revokerName}.${reason ? ` Reason: "${reason}"` : ''}`;

    await this.createNotification(userId, title, message, '/groups');

    const slackMsg = `🚫 *Hermes Access Revoked*\n--------------------------\nAccess to *${escapeSlackText(groupName)}* group was revoked by ${escapeSlackText(revokerName)} for User ID: ${escapeSlackText(userId)}.${reason ? `\nReason: "${escapeSlackText(reason)}"` : ''}`;
    await slackService.sendPing(slackMsg);

    const dm = `🚫 Your access to *${escapeSlackText(groupName)}* was revoked by ${escapeSlackText(revokerName)}.${reason ? `\nReason: "${escapeSlackText(reason)}"` : ''}\n👉 ${config.frontend.url}/groups`;
    await this.emailAndDm(userEmail, templates.userAccessRevoked({ groupName, revokerName, reason }), dm);
  }

  /** Human-friendly platform name for user-facing copy. */
  private platformLabel(platform?: string): string {
    const key = (platform || config.platform.default).toLowerCase();
    // Display name is adapter-owned (PlatformAdapter.displayName) — no per-platform
    // branching here, so a new adapter's name flows through automatically. Fall back
    // to a title-cased key for an unregistered platform.
    const adapter = provisioningRegistry.tryGet(key);
    if (adapter) return adapter.displayName;
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
      `${reviewerName} approved your request to ${groupName}. It will activate once you create a password for your ${label} account.`,
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
      `${reviewerName} approved your Hermes account. Check your email — ${label} has sent you a link to create your password.`,
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
    details?: Record<string, unknown>,
  ): Promise<void> {
    // Onboarding copy is platform-specific (Redash: "you're set up"; AWS: "set your
    // password via the access portal"). Each adapter owns its own message via
    // getOnboardingMessage(), so this stays platform-agnostic — a new platform just
    // supplies that method and needs no change here. `details` carries any per-completion
    // data from the invite (e.g. ZooKeeper's one-time credential) for the adapter to
    // render; this layer never inspects or branches on it.
    const adapter = provisioningRegistry.tryGet(platform);
    const onboarding = adapter?.getOnboardingMessage?.(details);

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
