import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import prisma from '../config/prisma';
import { NotFoundError } from '../utils/errors';
import { notificationIdSchema } from '../validations/notification.validation';

export class NotificationController extends BaseController {
  // GET /api/notifications
  async getNotifications(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      const notifications = await prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });

      this.sendResponse(notifications, 'Notifications retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve notifications');
    }
  }

  // PUT /api/notifications/:id/read
  async markAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const idResult = this.validateWithZod(notificationIdSchema, this.req.params.id, 'Invalid notification ID');
      if (!idResult.success) return;
      const id = idResult.data;

      const userId = this.getUserId();
      if (!userId) return;

      const notification = await prisma.notification.findFirst({
        where: { id, userId },
      });

      if (!notification) {
        throw new NotFoundError('Notification not found');
      }

      const updated = await prisma.notification.update({
        where: { id },
        data: { isRead: true },
      });

      this.sendResponse(updated, 'Notification marked as read');
    } catch (error) {
      this.handleError(error, 'Failed to mark notification as read');
    }
  }

  // PUT /api/notifications/read-all
  async markAllRead(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      const result = await prisma.notification.updateMany({
        where: { userId, isRead: false },
        data: { isRead: true },
      });

      this.sendResponse(result, `All notifications marked as read (${result.count} updated)`);
    } catch (error) {
      this.handleError(error, 'Failed to mark all notifications as read');
    }
  }

  // GET /api/notifications/unread-count
  async getUnreadCount(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      const count = await prisma.notification.count({
        where: { userId, isRead: false },
      });

      this.sendResponse({ count }, 'Unread count retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve unread count');
    }
  }
}
