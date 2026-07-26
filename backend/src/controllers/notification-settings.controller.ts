import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import config from '../config/config';
import logger from '../utils/logger';
import emailService from '../services/email.service';
import slackService from '../services/slack.service';
import notificationSettingsService, {
  SETTINGS_PROPAGATION_SECONDS,
} from '../services/notification-settings.service';
import {
  CATEGORIES,
  SCENARIOS,
  supportsChannel,
  type NotificationChannel,
  type NotificationScenario,
  type NotificationScenarioDef,
} from '../services/notification-scenarios';
import { isSuperAdmin } from '../utils/authz';
import { AuthorizationError, ValidationError } from '../utils/errors';
import {
  testNotificationSchema,
  updateNotificationSettingSchema,
} from '../validations/notification-settings.validation';

/** How long a super admin must wait between test sends on the same channel. */
const TEST_COOLDOWN_MS = 10_000;

/**
 * The global notification switchboard — super admin only.
 *
 * The route gates on `hermes_super_admin` via requireRole; the explicit check
 * here is defence in depth, because this endpoint can mute every outbound
 * notification in the system.
 *
 * Deliberately separate from `/api/admin/settings`, which is platform-scoped and
 * visible to platform admins. These settings are global, so folding them into
 * that endpoint would mean two different authorization models behind one URL.
 */
export class NotificationSettingsController extends BaseController {
  /** Last test send per `${userId}:${channel}` — process-local, best effort. */
  private static testCooldowns = new Map<string, number>();

  private assertSuperAdmin(): void {
    if (!isSuperAdmin(this.user!)) {
      throw new AuthorizationError(
        'Only super admins can manage notification settings',
      );
    }
  }

  /**
   * The scenarios this deployment can notify about. Hermes proper has no Apollo
   * login provisioning, so the catalogue is just the shared list; the admin-panel
   * copy of this file appends APOLLO_SCENARIOS here.
   */
  private catalogue(): NotificationScenarioDef[] {
    return SCENARIOS;
  }

  /**
   * Whether each transport is actually live, so the UI can say "this switch is
   * on but nothing is configured to send it".
   *
   * Never exposes the bot token — only a boolean leaves the server.
   */
  private health() {
    const emailLive = !config.email.isSimulation;
    const slackDmLive = !config.slack.dmSimulation;

    return {
      email: {
        live: emailLive,
        from: emailLive ? config.email.from : null,
        region: config.email.region ?? null,
        reason: emailLive
          ? null
          : config.email.from
            ? 'EMAIL_SIMULATION=true'
            : 'No EMAIL_FROM configured',
      },
      slackDm: {
        live: slackDmLive,
        reason: slackDmLive
          ? null
          : config.slack.botToken
            ? 'SLACK_SIMULATION=true'
            : 'No SLACK_BOT_TOKEN configured',
      },
    };
  }

  // GET /api/admin/notification-settings
  async getSettings(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      this.assertSuperAdmin();

      const { masters, scenarios: stored } =
        await notificationSettingsService.getAllRaw();

      // Per-scenario values are reported WITHOUT the master override folded in,
      // so turning a master back on reveals the grid exactly as it was left.
      const scenarios = this.catalogue().map(def => ({
        key: def.key,
        category: def.category,
        label: def.label,
        description: def.description,
        audience: def.audience,
        credentialBearing: !!def.credentialBearing,
        channels: {
          email: def.channels.email
            ? stored.get(def.key)?.email !== false
              ? 'on'
              : 'off'
            : 'na',
          slack: def.channels.slack
            ? stored.get(def.key)?.slack !== false
              ? 'on'
              : 'off'
            : 'na',
        },
      }));

      const usedCategories = new Set(scenarios.map(s => s.category));

      this.sendResponse(
        {
          categories: CATEGORIES.filter(c => usedCategories.has(c.key)),
          scenarios,
          masters,
          health: this.health(),
          propagationSeconds: SETTINGS_PROPAGATION_SECONDS,
        },
        'Notification settings retrieved',
      );
    } catch (error) {
      this.handleError(error, 'Failed to retrieve notification settings');
    }
  }

  // POST /api/admin/notification-settings
  async updateSetting(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      this.assertSuperAdmin();

      const validated = this.validateWithZod(
        updateNotificationSettingSchema,
        this.req.body,
      );
      if (!validated.success) {
        return;
      }
      const { scenario, channel, enabled } = validated.data;

      // A scenario that never delivers on a channel has no switch in the UI, so
      // a write here is a client bug — reject it rather than storing a row that
      // could never take effect.
      if (scenario !== 'master' && !supportsChannel(scenario, channel)) {
        throw new ValidationError(
          `The "${scenario}" notification does not use ${channel}`,
        );
      }

      await notificationSettingsService.set(
        scenario as NotificationScenario | 'master',
        channel as NotificationChannel,
        enabled,
      );

      this.sendResponse(
        { scenario, channel, enabled },
        'Notification setting updated',
      );
    } catch (error) {
      this.handleError(error, 'Failed to update the notification setting');
    }
  }

  // POST /api/admin/notification-settings/test
  //
  // Sends a sample message to the CALLER's own address. The recipient is never
  // taken from the request body — otherwise this would be an open relay for
  // mail and Slack DMs. It also deliberately bypasses the switchboard: the point
  // is to prove the transport works, not to check the policy.
  async sendTest(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      this.assertSuperAdmin();

      const validated = this.validateWithZod(
        testNotificationSchema,
        this.req.body,
      );
      if (!validated.success) {
        return;
      }
      const { channel } = validated.data;

      const userId = this.getUserId();
      if (!userId) {
        return;
      }

      const recipient = this.user!.email;
      if (!recipient) {
        throw new ValidationError(
          'Your account has no email address, so there is nowhere to send a test',
        );
      }

      const cooldownKey = `${userId}:${channel}`;
      const lastSent =
        NotificationSettingsController.testCooldowns.get(cooldownKey) ?? 0;
      const waitMs = lastSent + TEST_COOLDOWN_MS - Date.now();
      if (waitMs > 0) {
        throw new ValidationError(
          `Please wait ${Math.ceil(waitMs / 1000)}s before sending another ${channel} test`,
        );
      }
      NotificationSettingsController.testCooldowns.set(cooldownKey, Date.now());

      const sentAt = new Date().toISOString();

      if (channel === 'email') {
        await emailService.sendEmail({
          to: recipient,
          subject: '[Hermes] Test notification',
          html: `<p>This is a test email from Hermes, sent from the notification settings page at ${sentAt}.</p><p>If you received it, SES delivery is working.</p>`,
          text: `This is a test email from Hermes, sent from the notification settings page at ${sentAt}.\nIf you received it, SES delivery is working.`,
        });
        const { live, reason } = this.health().email;
        this.sendResponse(
          {
            channel,
            recipient,
            delivered: live,
            simulated: !live,
            reason,
          },
          live
            ? `Test email sent to ${recipient}`
            : 'Email is in simulation mode — the test was logged, not sent',
        );
        return;
      }

      const result = await slackService.sendDirectMessage(
        recipient,
        `🔔 This is a test Slack DM from Hermes, sent from the notification settings page at ${sentAt}. If you received it, DM delivery is working.`,
      );
      this.sendResponse(
        {
          channel,
          recipient,
          delivered: result.delivered,
          simulated: result.simulated,
          reason: result.reason ?? null,
        },
        result.delivered
          ? `Test Slack DM sent to ${recipient}`
          : result.simulated
            ? 'Slack is in simulation mode — the test was logged, not sent'
            : `Slack could not deliver the test: ${result.reason}`,
      );
    } catch (error) {
      logger.warn({ err: error }, 'Notification test send failed');
      this.handleError(error, 'Failed to send the test notification');
    }
  }
}

export default NotificationSettingsController;
