import { Router, Request, Response, NextFunction } from 'express';
import { AuditController } from '../controllers/audit.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.get('/', authenticateToken, requireRole(['hermes_super_admin']), (req: Request, res: Response, next: NextFunction) => {
  const controller = new AuditController(req, res, next);
  controller.getAuditLogs(req, res, next).catch(next);
});

export default router;
