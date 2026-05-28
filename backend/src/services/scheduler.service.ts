import cron, { ScheduledTask } from 'node-cron';
import prisma from '../config/prisma';
import accessWorkflowService from './access-workflow.service';
import syncService from './sync.service';
import config from '../config/config';
import logger from '../utils/logger';

export class SchedulerService {
  private expiryJob: ScheduledTask | null = null;
  private redashSyncJob: ScheduledTask | null = null;

  // Starts all cron jobs (auto-revoke + periodic Redash sync)
  start(): void {
    this.startExpiryJob();
    this.startRedashSyncJob();
  }

  // Stops all cron jobs
  stop(): void {
    if (this.expiryJob) {
      this.expiryJob.stop();
      this.expiryJob = null;
      logger.info('⏰ Scheduler Service: Expiry cron job stopped.');
    }
    if (this.redashSyncJob) {
      this.redashSyncJob.stop();
      this.redashSyncJob = null;
      logger.info('⏰ Scheduler Service: Redash sync cron job stopped.');
    }
  }

  private startExpiryJob(): void {
    // Hourly in prod, every 5 minutes in dev for faster feedback.
    const pattern = config.isDev ? '*/5 * * * *' : '0 * * * *';
    logger.info(`⏰ Scheduler Service: Starting auto-revocation cron job (pattern: ${pattern}).`);

    this.expiryJob = cron.schedule(pattern, async () => {
      logger.info('⏰ Scheduler Service: Checking for expired access grants...');
      await this.checkAndRevokeExpiredAccess();
    });
  }

  private startRedashSyncJob(): void {
    // Every 15 minutes in prod, every 5 minutes in dev.
    const pattern = config.isDev ? '*/5 * * * *' : '*/15 * * * *';
    logger.info(`⏰ Scheduler Service: Starting periodic Redash sync (pattern: ${pattern}).`);

    this.redashSyncJob = cron.schedule(pattern, async () => {
      try {
        const result = await syncService.syncWithRedash();
        logger.info(
          `⏰ Scheduler Service: Periodic Redash sync done — ${result.usersSynced} users, ${result.groupsSynced} groups.`,
        );
      } catch (err: any) {
        // Never throw out of the cron handler — a transient Redash hiccup
        // shouldn't tear down the scheduler.
        logger.warn(`⏰ Scheduler Service: Periodic Redash sync failed: ${err.message}`);
      }
    });
  }

  // Scan DB for expired accesses and run revocation workflow
  async checkAndRevokeExpiredAccess(): Promise<void> {
    try {
      const now = new Date();
      const expiredGrants = await prisma.userAccess.findMany({
        where: {
          isActive: true,
          expiresAt: {
            lt: now,
          },
        },
      });

      if (expiredGrants.length === 0) {
        logger.info('⏰ Scheduler Service: No expired access grants found.');
        return;
      }

      logger.info(`⏰ Scheduler Service: Found ${expiredGrants.length} expired access grants. Starting revocation...`);

      for (const grant of expiredGrants) {
        try {
          await accessWorkflowService.expireAccess(grant.id);
        } catch (err: any) {
          logger.error(`⏰ Scheduler Service: Error expiring grant ${grant.id}:`, err.message);
        }
      }

      logger.info('⏰ Scheduler Service: Completed processing expired access grants.');
    } catch (error: any) {
      logger.error('⏰ Scheduler Service: Fatal error during expiry scan:', error.message);
    }
  }
}

export const schedulerService = new SchedulerService();
export default schedulerService;
