import { Router, Request, Response, NextFunction } from 'express';
import { AccessRequestController } from '../controllers/access-request.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.post('/', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new AccessRequestController(req, res, next);
  controller.createRequest(req, res, next).catch(next);
});

router.get('/my', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new AccessRequestController(req, res, next);
  controller.getMyRequests(req, res, next).catch(next);
});

router.get('/pending', authenticateToken, requireRole(['hermes_super_admin', 'hermes_group_admin']), (req: Request, res: Response, next: NextFunction) => {
  const controller = new AccessRequestController(req, res, next);
  controller.getPendingRequests(req, res, next).catch(next);
});

router.get('/:id', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new AccessRequestController(req, res, next);
  controller.getRequestDetail(req, res, next).catch(next);
});

router.put('/:id/review', authenticateToken, requireRole(['hermes_super_admin', 'hermes_group_admin']), (req: Request, res: Response, next: NextFunction) => {
  const controller = new AccessRequestController(req, res, next);
  controller.reviewRequest(req, res, next).catch(next);
});

export default router;
