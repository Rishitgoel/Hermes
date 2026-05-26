import logger from '../utils/logger';
import config from '../config/config';
import { createHttpClient } from '../utils/http-client';

export class SlackService {
  private webhookUrl: string | null;
  private client: any;

  constructor() {
    const url = config.slack.webhookUrl;
    this.webhookUrl = url && url.startsWith('http') ? url : null;
    this.client = this.webhookUrl ? createHttpClient({ baseURL: this.webhookUrl }) : null;
  }

  async sendPing(text: string): Promise<void> {
    if (!this.client) {
      logger.info(`💬 [Slack Ping (Simulation)]: ${text}`);
      return;
    }

    try {
      await this.client.post('', { text });
      logger.info('💬 Slack ping sent successfully.');
    } catch (error: any) {
      logger.error('Failed to send Slack ping webhook:', error.message);
      // Fail silently to avoid breaking the request/approval lifecycle on third-party failure
    }
  }
}

export const slackService = new SlackService();
export default slackService;
