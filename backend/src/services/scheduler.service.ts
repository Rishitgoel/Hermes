import cron, { ScheduledTask } from 'node-cron';
import prisma from '../config/prisma';
import accessWorkflowService from './access-workflow.service';
import syncService from './sync.service';
import adminReconciliationService from './admin-reconciliation.service';
import zookeeperConfigService from './zookeeper-config.service';
import secretIngestionService from './secret-ingestion.service';
import config from '../config/config';
import logger from '../utils/logger';

// How many expirations to process concurrently per batch. Each one makes a
// platform API call (Redash / Identity Store deprovision) — unbounded fan-out
// over a large backlog would hammer the platform and trip its rate limits.
const EXPIRY_CONCURRENCY = 5;

// How many days ahead of expiry to send the one-time "expiring soon" heads-up.
const EXPIRY_WARNING_DAYS = 3;

// How many expiry-warning notifications to send concurrently per batch — same
// rationale as EXPIRY_CONCURRENCY, though this path makes no platform calls.
const EXPIRY_WARNING_CONCURRENCY = 10;

// Notification retention. Read notifications older than this are pruned (the user
// has seen them); ANY notification older than the hard cap is pruned regardless of
// read state, so the table can't grow without bound for a user who never opens the
// bell. Tuned generously — the bell only shows the most recent 50 anyway.
const NOTIFICATION_READ_RETENTION_DAYS = 30;
const NOTIFICATION_HARD_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export class SchedulerService {
  private expiryJob: ScheduledTask | null = null;
  private expiryWarningJob: ScheduledTask | null = null;
  private platformSyncJob: ScheduledTask | null = null;
  private adminReconcileJob: ScheduledTask | null = null;
  private zkApplyingSweepJob: ScheduledTask | null = null;
  private secretIngestionSweepJob: ScheduledTask | null = null;
  private notificationPruneJob: ScheduledTask | null = null;

  // Starts all cron jobs (auto-revoke + periodic platform sync + admin reconcile + ZK sweep + notification prune)
  start(): void {
    this.startExpiryJob();
    this.startExpiryWarningJob();
    this.startPlatformSyncJob();
    this.startAdminReconcileJob();
    this.startZkApplyingSweepJob();
    this.startSecretIngestionSweepJob();
    this.startNotificationPruneJob();
  }

  // Stops all cron jobs
  stop(): void {
    // node-cron's stop() returns a promise; we don't need to await teardown here.
    if (this.expiryJob) {
      void this.expiryJob.stop();
      this.expiryJob = null;
      logger.info('⏰ Scheduler Service: Expiry cron job stopped.');
    }
    if (this.expiryWarningJob) {
      void this.expiryWarningJob.stop();
      this.expiryWarningJob = null;
      logger.info('⏰ Scheduler Service: Expiry warning cron job stopped.');
    }
    if (this.platformSyncJob) {
      void this.platformSyncJob.stop();
      this.platformSyncJob = null;
      logger.info('⏰ Scheduler Service: Platform sync cron job stopped.');
    }
    if (this.adminReconcileJob) {
      void this.adminReconcileJob.stop();
      this.adminReconcileJob = null;
      logger.info(
        '⏰ Scheduler Service: Admin reconciliation cron job stopped.',
      );
    }
    if (this.zkApplyingSweepJob) {
      void this.zkApplyingSweepJob.stop();
      this.zkApplyingSweepJob = null;
      logger.info(
        '⏰ Scheduler Service: ZooKeeper APPLYING sweep cron job stopped.',
      );
    }
    if (this.secretIngestionSweepJob) {
      void this.secretIngestionSweepJob.stop();
      this.secretIngestionSweepJob = null;
      logger.info(
        '⏰ Scheduler Service: Secret Ingestion APPLYING sweep cron job stopped.',
      );
    }
    if (this.notificationPruneJob) {
      void this.notificationPruneJob.stop();
      this.notificationPruneJob = null;
      logger.info('⏰ Scheduler Service: Notification prune cron job stopped.');
    }
  }

  private startExpiryJob(): void {
    // Hourly in prod, every 5 minutes in dev for faster feedback.
    const pattern = config.isDev ? '*/5 * * * *' : '0 * * * *';
    logger.info(
      `⏰ Scheduler Service: Starting auto-revocation cron job (pattern: ${pattern}).`,
    );

    this.expiryJob = cron.schedule(pattern, async () => {
      logger.info(
        '⏰ Scheduler Service: Checking for expired access grants...',
      );
      await this.checkAndRevokeExpiredAccess();
    });
  }

  private startExpiryWarningJob(): void {
    // Once daily in prod (09:00); hourly in dev so the behaviour is observable
    // without waiting a day. This is a heads-up, not a time-critical action, so
    // unlike the expiry job itself it doesn't need a tight cadence.
    const pattern = config.isDev ? '0 * * * *' : '0 9 * * *';
    logger.info(
      `⏰ Scheduler Service: Starting expiry-warning cron job (pattern: ${pattern}).`,
    );

    this.expiryWarningJob = cron.schedule(pattern, async () => {
      logger.info(
        '⏰ Scheduler Service: Checking for soon-to-expire access grants...',
      );
      await this.checkAndWarnExpiringAccess();
    });
  }

  private startPlatformSyncJob(): void {
    // Every 15 minutes in prod, every 5 minutes in dev.
    const pattern = config.isDev ? '*/5 * * * *' : '*/15 * * * *';
    logger.info(
      `⏰ Scheduler Service: Starting periodic platform sync (pattern: ${pattern}).`,
    );

    this.platformSyncJob = cron.schedule(pattern, async () => {
      try {
        const result = await syncService.syncAllPlatforms();
        logger.info(
          `⏰ Scheduler Service: Periodic platform sync done — ${result.usersSynced} users, ${result.groupsSynced} groups.`,
        );
      } catch (err: any) {
        // Never throw out of the cron handler — a transient platform hiccup
        // shouldn't tear down the scheduler.
        logger.warn(
          `⏰ Scheduler Service: Periodic platform sync failed: ${err.message}`,
        );
      }
    });
  }

  private startAdminReconcileJob(): void {
    // Every 30 minutes in prod, every 10 minutes in dev. Repairs Keycloak↔mirror
    // drift for platform/group admins. No-op when Keycloak isn't live.
    const pattern = config.isDev ? '*/10 * * * *' : '*/30 * * * *';
    logger.info(
      `⏰ Scheduler Service: Starting admin reconciliation (pattern: ${pattern}).`,
    );

    this.adminReconcileJob = cron.schedule(pattern, async () => {
      try {
        await adminReconciliationService.reconcileAll();
      } catch (err: any) {
        // Never throw out of the cron handler.
        logger.warn(
          `⏰ Scheduler Service: Admin reconciliation failed: ${err.message}`,
        );
      }
    });
  }

  private startZkApplyingSweepJob(): void {
    // Every 10 minutes in prod, every 5 in dev. Recovers ZooKeeper change requests
    // orphaned in the transient APPLYING state by a process crash/redeploy mid-apply —
    // flips them to APPLY_FAILED (retryable) so they re-surface for review.
    const pattern = config.isDev ? '*/5 * * * *' : '*/10 * * * *';
    logger.info(
      `⏰ Scheduler Service: Starting ZooKeeper APPLYING sweep (pattern: ${pattern}).`,
    );

    this.zkApplyingSweepJob = cron.schedule(pattern, async () => {
      try {
        const recovered = await zookeeperConfigService.sweepStuckApplying();
        if (recovered > 0) {
          logger.warn(
            `⏰ Scheduler Service: Recovered ${recovered} stuck ZooKeeper change request(s).`,
          );
        }
      } catch (err: any) {
        // Never throw out of the cron handler.
        logger.warn(
          `⏰ Scheduler Service: ZooKeeper APPLYING sweep failed: ${err.message}`,
        );
      }
    });
  }

  private startSecretIngestionSweepJob(): void {
    // Every 10 minutes in prod, every 5 in dev. Recovers Secret Ingestion requests
    // orphaned in the transient APPLYING state by a process crash/redeploy mid-apply —
    // flips them to APPLY_FAILED (retryable) so they re-surface for review.
    const pattern = config.isDev ? '*/5 * * * *' : '*/10 * * * *';
    logger.info(
      `⏰ Scheduler Service: Starting Secret Ingestion APPLYING sweep (pattern: ${pattern}).`,
    );

    this.secretIngestionSweepJob = cron.schedule(pattern, async () => {
      try {
        const recovered = await secretIngestionService.sweepStuckApplying();
        if (recovered > 0) {
          logger.warn(
            `⏰ Scheduler Service: Recovered ${recovered} stuck Secret Ingestion change request(s).`,
          );
        }
        const synced = await secretIngestionService.syncOpenDeploymentPRs();
        if (synced > 0) {
          logger.info(
            `⏰ Scheduler Service: Synced ${synced} open Secret Ingestion deployment PR(s).`,
          );
        }
      } catch (err: any) {
        // Never throw out of the cron handler.
        logger.warn(
          `⏰ Scheduler Service: Secret Ingestion APPLYING sweep failed: ${err.message}`,
        );
      }
    });
  }

  private startNotificationPruneJob(): void {
    // Daily at 03:15 in prod; hourly in dev so the behaviour is observable without
    // waiting a day. Keeps the notifications table from growing unbounded.
    const pattern = config.isDev ? '15 * * * *' : '15 3 * * *';
    logger.info(
      `⏰ Scheduler Service: Starting notification prune (pattern: ${pattern}).`,
    );

    this.notificationPruneJob = cron.schedule(pattern, async () => {
      try {
        const removed = await this.pruneOldNotifications();
        if (removed > 0) {
          logger.info(
            `⏰ Scheduler Service: Pruned ${removed} old notification(s).`,
          );
        }
      } catch (err: any) {
        // Never throw out of the cron handler.
        logger.warn(
          `⏰ Scheduler Service: Notification prune failed: ${err.message}`,
        );
      }
    });
  }

  // Delete read notifications past the read-retention window, plus ANY notification
  // past the hard-retention cap (so an unopened bell can't accumulate forever).
  // Returns the number of rows removed.
  async pruneOldNotifications(): Promise<number> {
    const now = Date.now();
    const readCutoff = new Date(
      now - NOTIFICATION_READ_RETENTION_DAYS * DAY_MS,
    );
    const hardCutoff = new Date(
      now - NOTIFICATION_HARD_RETENTION_DAYS * DAY_MS,
    );

    const result = await prisma.notification.deleteMany({
      where: {
        OR: [
          { isRead: true, createdAt: { lt: readCutoff } },
          { createdAt: { lt: hardCutoff } },
        ],
      },
    });
    return result.count;
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

      logger.info(
        `⏰ Scheduler Service: Found ${expiredGrants.length} expired access grants. Starting revocation...`,
      );

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

      logger.info(
        '⏰ Scheduler Service: Completed processing expired access grants.',
      );
    } catch (error: any) {
      logger.error(
        '⏰ Scheduler Service: Fatal error during expiry scan:',
        error.message,
      );
    }
  }

  // Scan DB for grants expiring within EXPIRY_WARNING_DAYS that haven't been warned yet
  async checkAndWarnExpiringAccess(): Promise<void> {
    try {
      const now = new Date();
      const warningWindowEnd = new Date(
        now.getTime() + EXPIRY_WARNING_DAYS * DAY_MS,
      );
      const soonToExpire = await prisma.userAccess.findMany({
        where: {
          isActive: true,
          expiryWarnedAt: null,
          expiresAt: {
            gt: now,
            lte: warningWindowEnd,
          },
        },
      });

      if (soonToExpire.length === 0) {
        logger.info(
          '⏰ Scheduler Service: No soon-to-expire access grants found.',
        );
        return;
      }

      logger.info(
        `⏰ Scheduler Service: Found ${soonToExpire.length} soon-to-expire access grant(s). Sending warnings...`,
      );

      for (
        let i = 0;
        i < soonToExpire.length;
        i += EXPIRY_WARNING_CONCURRENCY
      ) {
        const batch = soonToExpire.slice(i, i + EXPIRY_WARNING_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(grant =>
            accessWorkflowService.warnExpiringAccess(grant.id),
          ),
        );
        results.forEach((result, j) => {
          if (result.status === 'rejected') {
            logger.error(
              `⏰ Scheduler Service: Error warning grant ${batch[j].id}:`,
              result.reason?.message ?? result.reason,
            );
          }
        });
      }

      logger.info(
        '⏰ Scheduler Service: Completed processing expiry warnings.',
      );
    } catch (error: any) {
      logger.error(
        '⏰ Scheduler Service: Fatal error during expiry-warning scan:',
        error.message,
      );
    }
  }
}

export const schedulerService = new SchedulerService();
export default schedulerService;
