import cron from 'node-cron';
import prisma from '../config/prisma';
import accessWorkflowService from './access-workflow.service';
import logger from '../utils/logger';

export class SchedulerService {
  private cronJob: any = null;

  // Starts the hourly cron job
  start(): void {
    logger.info('⏰ Scheduler Service: Starting auto-revocation hourly cron job...');

    // Run every hour: '0 * * * *'
    // For local dev/testing comfort, let's run it every 5 minutes in development mode if configured, or default to hourly
    const schedulePattern = process.env.NODE_ENV === 'development' ? '*/5 * * * *' : '0 * * * *';
    
    this.cronJob = cron.schedule(schedulePattern, async () => {
      logger.info('⏰ Scheduler Service: Checking for expired access grants...');
      await this.checkAndRevokeExpiredAccess();
    });
  }

  // Stops the cron job
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      logger.info('⏰ Scheduler Service: Hourly cron job stopped.');
    }
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
