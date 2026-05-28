"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.schedulerService = exports.SchedulerService = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const prisma_1 = __importDefault(require("../config/prisma"));
const access_workflow_service_1 = __importDefault(require("./access-workflow.service"));
const sync_service_1 = __importDefault(require("./sync.service"));
const config_1 = __importDefault(require("../config/config"));
const logger_1 = __importDefault(require("../utils/logger"));
class SchedulerService {
    expiryJob = null;
    redashSyncJob = null;
    // Starts all cron jobs (auto-revoke + periodic Redash sync)
    start() {
        this.startExpiryJob();
        this.startRedashSyncJob();
    }
    // Stops all cron jobs
    stop() {
        if (this.expiryJob) {
            this.expiryJob.stop();
            this.expiryJob = null;
            logger_1.default.info('⏰ Scheduler Service: Expiry cron job stopped.');
        }
        if (this.redashSyncJob) {
            this.redashSyncJob.stop();
            this.redashSyncJob = null;
            logger_1.default.info('⏰ Scheduler Service: Redash sync cron job stopped.');
        }
    }
    startExpiryJob() {
        // Hourly in prod, every 5 minutes in dev for faster feedback.
        const pattern = config_1.default.isDev ? '*/5 * * * *' : '0 * * * *';
        logger_1.default.info(`⏰ Scheduler Service: Starting auto-revocation cron job (pattern: ${pattern}).`);
        this.expiryJob = node_cron_1.default.schedule(pattern, async () => {
            logger_1.default.info('⏰ Scheduler Service: Checking for expired access grants...');
            await this.checkAndRevokeExpiredAccess();
        });
    }
    startRedashSyncJob() {
        // Every 15 minutes in prod, every 5 minutes in dev.
        const pattern = config_1.default.isDev ? '*/5 * * * *' : '*/15 * * * *';
        logger_1.default.info(`⏰ Scheduler Service: Starting periodic Redash sync (pattern: ${pattern}).`);
        this.redashSyncJob = node_cron_1.default.schedule(pattern, async () => {
            try {
                const result = await sync_service_1.default.syncWithRedash();
                logger_1.default.info(`⏰ Scheduler Service: Periodic Redash sync done — ${result.usersSynced} users, ${result.groupsSynced} groups.`);
            }
            catch (err) {
                // Never throw out of the cron handler — a transient Redash hiccup
                // shouldn't tear down the scheduler.
                logger_1.default.warn(`⏰ Scheduler Service: Periodic Redash sync failed: ${err.message}`);
            }
        });
    }
    // Scan DB for expired accesses and run revocation workflow
    async checkAndRevokeExpiredAccess() {
        try {
            const now = new Date();
            const expiredGrants = await prisma_1.default.userAccess.findMany({
                where: {
                    isActive: true,
                    expiresAt: {
                        lt: now,
                    },
                },
            });
            if (expiredGrants.length === 0) {
                logger_1.default.info('⏰ Scheduler Service: No expired access grants found.');
                return;
            }
            logger_1.default.info(`⏰ Scheduler Service: Found ${expiredGrants.length} expired access grants. Starting revocation...`);
            for (const grant of expiredGrants) {
                try {
                    await access_workflow_service_1.default.expireAccess(grant.id);
                }
                catch (err) {
                    logger_1.default.error(`⏰ Scheduler Service: Error expiring grant ${grant.id}:`, err.message);
                }
            }
            logger_1.default.info('⏰ Scheduler Service: Completed processing expired access grants.');
        }
        catch (error) {
            logger_1.default.error('⏰ Scheduler Service: Fatal error during expiry scan:', error.message);
        }
    }
}
exports.SchedulerService = SchedulerService;
exports.schedulerService = new SchedulerService();
exports.default = exports.schedulerService;
