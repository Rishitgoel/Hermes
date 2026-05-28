import { Router, Request, Response, NextFunction } from 'express';
import { AdminController } from '../controllers/admin.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.post('/sync', authenticateToken, requireRole(['hermes_super_admin']), (req: Request, res: Response, next: NextFunction) => {
  const controller = new AdminController(req, res, next);
  controller.triggerSync(req, res, next).catch(next);
});

export default router;
