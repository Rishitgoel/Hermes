"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.notificationService = exports.NotificationService = void 0;
const prisma_1 = __importDefault(require("../config/prisma"));
const slack_service_1 = __importDefault(require("./slack.service"));
const logger_1 = __importDefault(require("../utils/logger"));
const config_1 = __importDefault(require("../config/config"));
class NotificationService {
    // Create a general in-app notification
    async createNotification(userId, title, message, linkUrl) {
        try {
            await prisma_1.default.notification.create({
                data: {
                    userId,
                    title,
                    message,
                    linkUrl,
                },
            });
            logger_1.default.info(`🔔 In-app notification created for user ${userId}: "${title}"`);
        }
        catch (error) {
            logger_1.default.error(`Failed to create in-app notification for ${userId}:`, error.message);
        }
    }
    // User requests access -> notify Group Admins (in-app) + Slack ping
    async notifyRequestCreated(requestId, groupId, groupName, requesterName, justification, duration) {
        // 1. Send Slack Ping
        const slackMsg = `📋 *Atlas Access Request*\n--------------------------\n*${requesterName}* requested access to the *${groupName}* group.\nReason: "${justification}"\nDuration: ${duration.replace('_', ' ').toLowerCase()}\n\n👉 Review in Atlas: ${config_1.default.frontend.url}/pending-approvals`;
        await slack_service_1.default.sendPing(slackMsg);
        // 2. Query Group Admins from DB and send in-app notification
        try {
            const groupAdmins = await prisma_1.default.groupAdmin.findMany({
                where: { groupId },
            });
            for (const admin of groupAdmins) {
                await this.createNotification(admin.userId, 'Pending Approval Request', `${requesterName} requested access to ${groupName}.`, `/pending-approvals`);
            }
        }
        catch (error) {
            logger_1.default.error('Failed to notify group admins in-app:', error.message);
        }
    }
    // Request is approved/rejected -> notify requester
    async notifyRequestReviewed(requesterId, groupName, approved, reviewerName, note) {
        const statusText = approved ? 'APPROVED' : 'REJECTED';
        const title = `Access Request ${statusText}`;
        const message = approved
            ? `Your access request to ${groupName} was approved by ${reviewerName}.${note ? ` Note: "${note}"` : ''}`
            : `Your access request to ${groupName} was rejected by ${reviewerName}.${note ? ` Reason: "${note}"` : ''}`;
        await this.createNotification(requesterId, title, message, approved ? '/' : '/my-requests');
        // Notify requester via Slack if possible (simulation simply pings admin webhook channel)
        const slackMsg = `📢 *Atlas Access Update*\n--------------------------\nAccess request to *${groupName}* was *${statusText}* by ${reviewerName}.${note ? `\nNote: "${note}"` : ''}`;
        await slack_service_1.default.sendPing(slackMsg);
    }
    // Access is auto-expired
    async notifyAccessExpired(userId, groupName) {
        const title = 'Access Expired';
        const message = `Your temporary access to ${groupName} group has expired.`;
        await this.createNotification(userId, title, message, '/groups');
        const slackMsg = `⏳ *Atlas Access Expired*\n--------------------------\nAccess to *${groupName}* group has expired for User ID: ${userId}`;
        await slack_service_1.default.sendPing(slackMsg);
    }
    // Access is manually revoked by admin
    async notifyAccessRevoked(userId, groupName, revokerName, reason) {
        const title = 'Access Revoked';
        const message = `Your access to ${groupName} group was revoked by ${revokerName}.${reason ? ` Reason: "${reason}"` : ''}`;
        await this.createNotification(userId, title, message, '/groups');
        const slackMsg = `🚫 *Atlas Access Revoked*\n--------------------------\nAccess to *${groupName}* group was revoked by ${revokerName} for User ID: ${userId}.${reason ? `\nReason: "${reason}"` : ''}`;
        await slack_service_1.default.sendPing(slackMsg);
    }
}
exports.NotificationService = NotificationService;
exports.notificationService = new NotificationService();
exports.default = exports.notificationService;
