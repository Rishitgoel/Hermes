import logger from '../utils/logger';
import config from '../config/config';
import { createHttpClient } from '../utils/http-client';

export class SlackService {
  private webhookClient: any;
  private webhookClientUrl: string | null = null;
  private apiClient: any;
  private apiClientToken: string | null = null;

  /**
   * Lazily build the webhook client. Built on first use (not in the constructor)
   * so the URL is read *after* loadSecrets() has populated env in production.
   * Re-created if the configured URL changes.
   */
  private getWebhookClient(): any | null {
    const url = config.slack.webhookUrl;
    const valid = url && url.startsWith('http') ? url : null;
    if (!valid) return null;
    if (this.webhookClient && this.webhookClientUrl === valid) return this.webhookClient;
    this.webhookClient = createHttpClient({ baseURL: valid });
    this.webhookClientUrl = valid;
    return this.webhookClient;
  }

  /**
   * Lazily build the Web API client (needs a bot token). Read at call time and
   * rebuilt if the token changes, so a token injected by loadSecrets() after
   * import (or rotated at runtime) is always honoured.
   */
  private getApiClient(): any | null {
    if (config.slack.dmSimulation) return null;
    const token = config.slack.botToken as string;
    if (this.apiClient && this.apiClientToken === token) return this.apiClient;
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

  /** Post to the shared channel via incoming webhook (team feed). Optional. */
  async sendPing(text: string): Promise<void> {
    const client = this.getWebhookClient();
    if (!client) {
      logger.info(`💬 [Slack Ping (Simulation)]: ${text}`);
      return;
    }

    try {
      await client.post('', { text });
      logger.info('💬 Slack ping sent successfully.');
    } catch (error: any) {
      logger.error('Failed to send Slack ping webhook:', error.message);
      // Fail silently to avoid breaking the request/approval lifecycle on third-party failure
    }
  }

  /**
   * Send a private DM to a user, resolved by their email via the Web API.
   * Requires a bot token with `users:read.email` + `chat:write`. In simulation
   * (no bot token, or SLACK_SIMULATION=true) it just logs. Fails silently.
   */
  async sendDirectMessage(email: string, text: string): Promise<void> {
    if (!email) {
      logger.warn('💬 Slack DM skipped — no email');
      return;
    }

    const client = this.getApiClient();
    if (!client) {
      logger.info(`💬 [Slack DM (Simulation)] → ${email}: ${text}`);
      return;
    }

    try {
      const lookup = await client.get('/users.lookupByEmail', { params: { email } });
      if (!lookup.data?.ok) {
        logger.warn({ email, error: lookup.data?.error }, 'Slack DM: could not resolve user by email');
        return;
      }
      const userId = lookup.data.user.id;

      const post = await client.post('/chat.postMessage', { channel: userId, text });
      if (!post.data?.ok) {
        logger.warn({ email, error: post.data?.error }, 'Slack DM: chat.postMessage failed');
        return;
      }
      logger.info(`💬 Slack DM sent → ${email}`);
    } catch (error: any) {
      logger.error({ email, err: error.message }, 'Failed to send Slack DM');
      // Fail silently — Slack must never break the approval lifecycle.
    }
  }
}

export const slackService = new SlackService();
export default slackService;
