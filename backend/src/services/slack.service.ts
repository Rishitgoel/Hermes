import logger from '../utils/logger';
import axios from 'axios';

export class SlackService {
  private webhookUrl: string | null;

  constructor() {
    const url = process.env.SLACK_WEBHOOK_URL;
    this.webhookUrl = url && url.startsWith('http') ? url : null;
  }

  async sendPing(text: string): Promise<void> {
    if (!this.webhookUrl) {
      logger.info(`💬 [Slack Ping (Simulation)]: ${text}`);
      return;
    }

    try {
      await axios.post(this.webhookUrl, { text });
      logger.info('💬 Slack ping sent successfully.');
    } catch (error: any) {
      logger.error('Failed to send Slack ping webhook:', error.message);
      // Fail silently to avoid breaking the request/approval lifecycle on third-party failure
    }
  }
}

export const slackService = new SlackService();
export default slackService;
