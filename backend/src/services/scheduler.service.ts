import cron, { ScheduledTask } from 'node-cron';
import prisma from '../config/prisma';
import accessWorkflowService from './access-workflow.service';
import syncService from './sync.service';
import adminReconciliationService from './admin-reconciliation.service';
import config from '../config/config';
import logger from '../utils/logger';

// How many expirations to process concurrently per batch. Each one makes a
// platform API call (Redash / Identity Store deprovision) — unbounded fan-out
// over a large backlog would hammer the platform and trip its rate limits.
const EXPIRY_CONCURRENCY = 5;

export class SchedulerService {
  private expiryJob: ScheduledTask | null = null;
  private platformSyncJob: ScheduledTask | null = null;
  private adminReconcileJob: ScheduledTask | null = null;

  // Starts all cron jobs (auto-revoke + periodic platform sync + admin reconcile)
  start(): void {
    this.startExpiryJob();
    this.startPlatformSyncJob();
    this.startAdminReconcileJob();
  }

  // Stops all cron jobs
  stop(): void {
    if (this.expiryJob) {
      this.expiryJob.stop();
      this.expiryJob = null;
      logger.info('⏰ Scheduler Service: Expiry cron job stopped.');
    }
    if (this.platformSyncJob) {
      this.platformSyncJob.stop();
      this.platformSyncJob = null;
      logger.info('⏰ Scheduler Service: Platform sync cron job stopped.');
    }
    if (this.adminReconcileJob) {
      this.adminReconcileJob.stop();
      this.adminReconcileJob = null;
      logger.info('⏰ Scheduler Service: Admin reconciliation cron job stopped.');
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

  private startPlatformSyncJob(): void {
    // Every 15 minutes in prod, every 5 minutes in dev.
    const pattern = config.isDev ? '*/5 * * * *' : '*/15 * * * *';
    logger.info(`⏰ Scheduler Service: Starting periodic platform sync (pattern: ${pattern}).`);

    this.platformSyncJob = cron.schedule(pattern, async () => {
      try {
        const result = await syncService.syncAllPlatforms();
        logger.info(
          `⏰ Scheduler Service: Periodic platform sync done — ${result.usersSynced} users, ${result.groupsSynced} groups.`,
        );
      } catch (err: any) {
        // Never throw out of the cron handler — a transient platform hiccup
        // shouldn't tear down the scheduler.
        logger.warn(`⏰ Scheduler Service: Periodic platform sync failed: ${err.message}`);
      }
    });
  }

  private startAdminReconcileJob(): void {
    // Every 30 minutes in prod, every 10 minutes in dev. Repairs Keycloak↔mirror
    // drift for platform/group admins. No-op when Keycloak isn't live.
    const pattern = config.isDev ? '*/10 * * * *' : '*/30 * * * *';
    logger.info(`⏰ Scheduler Service: Starting admin reconciliation (pattern: ${pattern}).`);

    this.adminReconcileJob = cron.schedule(pattern, async () => {
      try {
        await adminReconciliationService.reconcileAll();
      } catch (err: any) {
        // Never throw out of the cron handler.
        logger.warn(`⏰ Scheduler Service: Admin reconciliation failed: ${err.message}`);
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

      // Revoke concurrently in bounded batches — one slow platform call shouldn't
      // hold up the rest, but a big backlog must not fan out into hundreds of
      // simultaneous platform calls either. allSettled so a single failure is
      // logged without aborting the batch.
      for (let i = 0; i < expiredGrants.length; i += EXPIRY_CONCURRENCY) {
        const batch = expiredGrants.slice(i, i + EXPIRY_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(grant => accessWorkflowService.expireAccess(grant.id)),
        );
        results.forEach((result, j) => {
          if (result.status === 'rejected') {
            logger.error(
              `⏰ Scheduler Service: Error expiring grant ${batch[j].id}:`,
              result.reason?.message ?? result.reason,
            );
          }
        });
      }

      logger.info('⏰ Scheduler Service: Completed processing expired access grants.');
    } catch (error: any) {
      logger.error('⏰ Scheduler Service: Fatal error during expiry scan:', error.message);
    }
  }
}

export const schedulerService = new SchedulerService();
export default schedulerService;
