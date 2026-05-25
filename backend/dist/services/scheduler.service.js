"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.schedulerService = exports.SchedulerService = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const prisma_1 = __importDefault(require("../config/prisma"));
const access_workflow_service_1 = __importDefault(require("./access-workflow.service"));
const logger_1 = __importDefault(require("../utils/logger"));
class SchedulerService {
    cronJob = null;
    // Starts the hourly cron job
    start() {
        logger_1.default.info('⏰ Scheduler Service: Starting auto-revocation hourly cron job...');
        // Run every hour: '0 * * * *'
        // For local dev/testing comfort, let's run it every 5 minutes in development mode if configured, or default to hourly
        const schedulePattern = process.env.NODE_ENV === 'development' ? '*/5 * * * *' : '0 * * * *';
        this.cronJob = node_cron_1.default.schedule(schedulePattern, async () => {
            logger_1.default.info('⏰ Scheduler Service: Checking for expired access grants...');
            await this.checkAndRevokeExpiredAccess();
        });
    }
    // Stops the cron job
    stop() {
        if (this.cronJob) {
            this.cronJob.stop();
            logger_1.default.info('⏰ Scheduler Service: Hourly cron job stopped.');
        }
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
