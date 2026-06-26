import { Router, Request, Response, NextFunction } from 'express';
import { NotificationController } from '../controllers/notification.controller';
import { authenticateToken, injectQueryTokenAsHeader } from '../middleware/auth.middleware';

const router = Router();

// SSE stream — one persistent connection per tab (replaces 60s polling, P2-6).
// injectQueryTokenAsHeader lets EventSource authenticate via ?token=; the rest of
// the auth chain is the standard one. Registered before '/' for clarity.
router.get(
  '/stream',
  injectQueryTokenAsHeader,
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    const controller = new NotificationController(req, res, next);
    controller.streamNotifications(req, res, next).catch(next);
  },
);

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

// Clear all of the user's notifications. Registered before '/:id' so the bare
// path isn't captured by the param route.
router.delete('/', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new NotificationController(req, res, next);
  controller.clearAll(req, res, next).catch(next);
});

router.delete('/:id', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new NotificationController(req, res, next);
  controller.dismissNotification(req, res, next).catch(next);
});

export default router;
