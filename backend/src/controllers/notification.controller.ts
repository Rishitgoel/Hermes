import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import prisma from '../config/prisma';
import { NotFoundError } from '../utils/errors';
import { notificationIdSchema } from '../validations/notification.validation';
import notificationStreamService from '../services/notification-stream.service';

export class NotificationController extends BaseController {
  // GET /api/notifications/stream  (Server-Sent Events)
  // Long-lived connection that pushes each new in-app notification for the
  // authenticated user as it's created — replaces the 60s polling (P2-6). Auth is
  // handled by the route's middleware (token read from ?token= since EventSource
  // can't set an Authorization header).
  async streamNotifications(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const userId = this.getUserId();
    if (!userId) {return;}

    // SSE headers. no-transform + X-Accel-Buffering:no stop any proxy/compression
    // from buffering the stream; we never gzip an event stream.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Open the stream immediately (comment line) and flush past any buffering layer.
    res.write(': connected\n\n');
    (res as unknown as { flush?: () => void }).flush?.();

    notificationStreamService.addClient(userId, res);

    // Idempotent (clearInterval + Set.delete), so being called from both a write
    // failure and a later close/error event is harmless. Defined before `heartbeat`
    // (which it references in a closure) so it can be called from the heartbeat below.
    const cleanup = () => {
      clearInterval(heartbeat);
      notificationStreamService.removeClient(userId, res);
    };

    // Heartbeat keeps idle intermediaries from closing the connection and surfaces a
    // dead socket. Comment frames are ignored by EventSource. A write failure means
    // the socket is gone, so tear down immediately rather than waiting (only) for the
    // close/error events to fire.
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        cleanup();
      }
    }, 25000);

    req.on('close', cleanup);
    res.on('error', cleanup);
  }

  // GET /api/notifications
  async getNotifications(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) {return;}

      // Cap the payload — the bell only ever shows the most recent slice, and an
      // unbounded list let heavy users accumulate hundreds of rows. The unread
      // badge still reflects the true total via /unread-count.
      const notifications = await prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });

      this.sendResponse(notifications, 'Notifications retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve notifications');
    }
  }

  // PUT /api/notifications/:id/read
  async markAsRead(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const idResult = this.validateWithZod(
        notificationIdSchema,
        this.req.params.id,
        'Invalid notification ID',
      );
      if (!idResult.success) {return;}
      const id = idResult.data;

      const userId = this.getUserId();
      if (!userId) {return;}

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
  async markAllRead(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) {return;}

      const result = await prisma.notification.updateMany({
        where: { userId, isRead: false },
        data: { isRead: true },
      });

      this.sendResponse(
        result,
        `All notifications marked as read (${result.count} updated)`,
      );
    } catch (error) {
      this.handleError(error, 'Failed to mark all notifications as read');
    }
  }

  // DELETE /api/notifications/:id — dismiss (permanently remove) a single notification.
  async dismissNotification(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const idResult = this.validateWithZod(
        notificationIdSchema,
        this.req.params.id,
        'Invalid notification ID',
      );
      if (!idResult.success) {return;}
      const id = idResult.data;

      const userId = this.getUserId();
      if (!userId) {return;}

      // deleteMany (not delete) so another user's id can never be removed and a
      // missing row is a no-op rather than a thrown P2025.
      const result = await prisma.notification.deleteMany({
        where: { id, userId },
      });
      if (result.count === 0) {
        throw new NotFoundError('Notification not found');
      }

      this.sendResponse({ id }, 'Notification dismissed');
    } catch (error) {
      this.handleError(error, 'Failed to dismiss notification');
    }
  }

  // DELETE /api/notifications — clear every notification for the authenticated user.
  async clearAll(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) {return;}

      const result = await prisma.notification.deleteMany({
        where: { userId },
      });

      this.sendResponse(
        result,
        `All notifications cleared (${result.count} removed)`,
      );
    } catch (error) {
      this.handleError(error, 'Failed to clear notifications');
    }
  }

  // GET /api/notifications/unread-count
  async getUnreadCount(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) {return;}

      const count = await prisma.notification.count({
        where: { userId, isRead: false },
      });

      this.sendResponse({ count }, 'Unread count retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve unread count');
    }
  }
}
