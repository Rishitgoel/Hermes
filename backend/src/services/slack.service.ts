import logger from '../utils/logger';
import config from '../config/config';
import { createHttpClient } from '../utils/http-client';

/**
 * Outcome of a DM attempt. Most callers (approval/request notifications) ignore
 * this and rely on the fail-silently behaviour, but anything delivering
 * something the recipient *cannot obtain another way* — a one-time password, a
 * setup token — must branch on it, otherwise a failed lookup silently strands
 * the user.
 */
export interface SlackDeliveryResult {
  delivered: boolean;
  /** No bot token configured (or SLACK_SIMULATION=true): logged, never sent. */
  simulated: boolean;
  /** Slack API error code, or a short reason, when not delivered. */
  reason?: string;
}

export class SlackService {
  private apiClient: any;
  private apiClientToken: string | null = null;

  /**
   * Lazily build the Web API client (needs a bot token). Read at call time and
   * rebuilt if the token changes, so a token injected by loadSecrets() after
   * import (or rotated at runtime) is always honoured.
   */
  private getApiClient(): any | null {
    if (config.slack.dmSimulation) {return null;}
    const token = config.slack.botToken as string;
    if (this.apiClient && this.apiClientToken === token) {return this.apiClient;}
    this.apiClient = createHttpClient({
      baseURL: 'https://slack.com/api',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
    this.apiClientToken = token;
    return this.apiClient;
  }

  /**
   * Send a private DM to a user, resolved by their email via the Web API.
   * Requires a bot token with `users:read.email` + `chat:write`. In simulation
   * (no bot token, or SLACK_SIMULATION=true) it just logs.
   *
   * Never throws — Slack must not break the approval lifecycle — but it does
   * *report* what happened, so callers delivering something irreplaceable can
   * fall back. Callers that don't care can keep ignoring the return value.
   *
   * Pass `redactInLogs` when the message body contains a secret. The simulation
   * branch below echoes the whole message to the log so local dev can read it,
   * which is exactly the wrong thing to do with a temporary password: Slack can
   * be simulated (no bot token) while Keycloak is live, so without this the
   * credential would land in production logs.
   */
  async sendDirectMessage(
    email: string,
    text: string,
    opts: { redactInLogs?: boolean } = {},
  ): Promise<SlackDeliveryResult> {
    if (!email) {
      logger.warn('💬 Slack DM skipped — no email');
      return { delivered: false, simulated: false, reason: 'no_email' };
    }

    const client = this.getApiClient();
    if (!client) {
      logger.info(
        `💬 [Slack DM (Simulation)] → ${email}: ${opts.redactInLogs ? '<redacted — message contains a credential>' : text}`,
      );
      return { delivered: false, simulated: true, reason: 'simulation' };
    }

    try {
      const lookup = await client.get('/users.lookupByEmail', { params: { email } });
      if (!lookup.data?.ok) {
        logger.warn({ email, error: lookup.data?.error }, 'Slack DM: could not resolve user by email');
        return {
          delivered: false,
          simulated: false,
          reason: lookup.data?.error || 'users_not_found',
        };
      }
      const userId = lookup.data.user.id;

      const post = await client.post('/chat.postMessage', { channel: userId, text });
      if (!post.data?.ok) {
        logger.warn({ email, error: post.data?.error }, 'Slack DM: chat.postMessage failed');
        return {
          delivered: false,
          simulated: false,
          reason: post.data?.error || 'post_message_failed',
        };
      }
      logger.info(`💬 Slack DM sent → ${email}`);
      return { delivered: true, simulated: false };
    } catch (error: any) {
      logger.error({ email, err: error.message }, 'Failed to send Slack DM');
      // Fail silently — Slack must never break the approval lifecycle.
      return { delivered: false, simulated: false, reason: error.message };
    }
  }
}

export const slackService = new SlackService();
export default slackService;
