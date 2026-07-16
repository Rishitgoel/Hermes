import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import logger from '../utils/logger';
import config from '../config/config';

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Thin wrapper around AWS SES (v2). Mirrors SlackService:
 *  - Simulation mode (no sender configured, or EMAIL_SIMULATION=true) just logs.
 *  - Real failures are logged and swallowed so a bad email never breaks the
 *    request/approval lifecycle on a third-party hiccup.
 *
 * Credentials: if AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are present we pass
 * them explicitly (matching config/secrets.ts); otherwise the SDK's default
 * provider chain is used (IAM role on the box). Either way SES picks the region
 * from config.email.region (SES_REGION || AWS_REGION).
 */
export class EmailService {
  private client: SESv2Client | null = null;

  private getClient(): SESv2Client | null {
    if (config.email.isSimulation) {return null;}
    if (this.client) {return this.client;}

    const { region } = config.email;
    if (!region) {
      logger.warn('EMAIL: no SES region configured (SES_REGION / AWS_REGION). Falling back to simulation.');
      return null;
    }

    const { accessKeyId, secretAccessKey } = config.aws;
    this.client = new SESv2Client({
      region,
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });
    return this.client;
  }

  async sendEmail({ to, subject: rawSubject, html, text }: SendEmailInput): Promise<void> {
    // Subjects interpolate user-controlled values (display names, group names).
    // Strip CR/LF so a crafted name can never smuggle extra headers into the
    // message — defense-in-depth on top of whatever SES itself rejects.
    const subject = rawSubject.replace(/[\r\n]+/g, ' ').trim();
    if (!to) {
      logger.warn({ subject }, 'EMAIL: skipped — no recipient address');
      return;
    }

    const client = this.getClient();
    if (!client) {
      logger.info(`📧 [Email (Simulation)] → ${to} | ${subject}`);
      return;
    }

    try {
      await client.send(
        new SendEmailCommand({
          FromEmailAddress: config.email.from,
          Destination: { ToAddresses: [to] },
          ...(config.email.replyTo ? { ReplyToAddresses: [config.email.replyTo] } : {}),
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: html, Charset: 'UTF-8' },
                Text: { Data: text, Charset: 'UTF-8' },
              },
            },
          },
        }),
      );
      logger.info(`📧 Email sent → ${to} | ${subject}`);
    } catch (error: any) {
      logger.error({ to, subject, err: error.message }, 'Failed to send email via SES');
      // Fail silently — see class doc.
    }
  }
}

export const emailService = new EmailService();
export default emailService;
