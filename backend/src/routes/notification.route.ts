import { Router, Request, Response, NextFunction } from 'express';
import { NotificationController } from '../controllers/notification.controller';
import { authenticateToken } from '../middleware/auth.middleware';

const router = Router();

router.get('/', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new NotificationController(req, res, next);
  controller.getNotifications(req, res, next).catch(next);
});

router.get('/unread-count', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new NotificationController(req, res, next);
  controller.getUnreadCount(req, res, next).catch(next);
});

router.put('/read-all', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new NotificationController(req, res, next);
  controller.markAllRead(req, res, next).catch(next);
});

router.put('/:id/read', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new NotificationController(req, res, next);
  controller.markAsRead(req, res, next).catch(next);
});

export default router;
