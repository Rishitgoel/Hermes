import { Router, Request, Response, NextFunction } from 'express';
import { UserCreationController } from '../controllers/user-creation.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

// User-facing endpoints (any authenticated user)
router.post('/', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new UserCreationController(req, res, next);
  controller.submit(req, res, next).catch(next);
});

router.get('/me', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new UserCreationController(req, res, next);
  controller.getMine(req, res, next).catch(next);
});

router.post('/me/resend', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new UserCreationController(req, res, next);
  controller.resendMine(req, res, next).catch(next);
});

router.post('/me/sync-now', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new UserCreationController(req, res, next);
  controller.syncMine(req, res, next).catch(next);
});

// Admin endpoints — user-creation is org-wide, so restrict to super-admins only.
// Group admins should not be able to approve a brand-new user into Hermes.
router.get(
  '/pending',
  authenticateToken,
  requireRole(['hermes_super_admin']),
  (req: Request, res: Response, next: NextFunction) => {
    const controller = new UserCreationController(req, res, next);
    controller.listPending(req, res, next).catch(next);
  },
);

router.put(
  '/:id/review',
  authenticateToken,
  requireRole(['hermes_super_admin']),
  (req: Request, res: Response, next: NextFunction) => {
    const controller = new UserCreationController(req, res, next);
    controller.review(req, res, next).catch(next);
  },
);

export default router;
