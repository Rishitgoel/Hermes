"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationController = void 0;
const base_controller_1 = __importDefault(require("./base.controller"));
const prisma_1 = __importDefault(require("../config/prisma"));
const errors_1 = require("../utils/errors");
const notification_validation_1 = require("../validations/notification.validation");
class NotificationController extends base_controller_1.default {
    // GET /api/notifications
    async getNotifications(req, res, next) {
        try {
            const userId = this.getUserId();
            if (!userId)
                return;
            const notifications = await prisma_1.default.notification.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
            });
            this.sendResponse(notifications, 'Notifications retrieved successfully');
        }
        catch (error) {
            this.handleError(error, 'Failed to retrieve notifications');
        }
    }
    // PUT /api/notifications/:id/read
    async markAsRead(req, res, next) {
        try {
            const idResult = this.validateWithZod(notification_validation_1.notificationIdSchema, this.req.params.id, 'Invalid notification ID');
            if (!idResult.success)
                return;
            const id = idResult.data;
            const userId = this.getUserId();
            if (!userId)
                return;
            const notification = await prisma_1.default.notification.findFirst({
                where: { id, userId },
            });
            if (!notification) {
                throw new errors_1.NotFoundError('Notification not found');
            }
            const updated = await prisma_1.default.notification.update({
                where: { id },
                data: { isRead: true },
            });
            this.sendResponse(updated, 'Notification marked as read');
        }
        catch (error) {
            this.handleError(error, 'Failed to mark notification as read');
        }
    }
    // PUT /api/notifications/read-all
    async markAllRead(req, res, next) {
        try {
            const userId = this.getUserId();
            if (!userId)
                return;
            const result = await prisma_1.default.notification.updateMany({
                where: { userId, isRead: false },
                data: { isRead: true },
            });
            this.sendResponse(result, `All notifications marked as read (${result.count} updated)`);
        }
        catch (error) {
            this.handleError(error, 'Failed to mark all notifications as read');
        }
    }
    // GET /api/notifications/unread-count
    async getUnreadCount(req, res, next) {
        try {
            const userId = this.getUserId();
            if (!userId)
                return;
            const count = await prisma_1.default.notification.count({
                where: { userId, isRead: false },
            });
            this.sendResponse({ count }, 'Unread count retrieved successfully');
        }
        catch (error) {
            this.handleError(error, 'Failed to retrieve unread count');
        }
    }
}
exports.NotificationController = NotificationController;
