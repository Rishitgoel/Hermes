import { Router, Request, Response, NextFunction } from 'express';
import { AccessRequestController } from '../controllers/access-request.controller';
import { authenticateToken } from '../middleware/auth.middleware';

const router = Router();

router.post('/', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new AccessRequestController(req, res, next);
  controller.createRequest(req, res, next).catch(next);
});

// Bulk submit — one call instead of N. Static path, so no conflict with POST '/'.
router.post('/bulk', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new AccessRequestController(req, res, next);
  controller.createRequestsBulk(req, res, next).catch(next);
});

// Bulk review — MUST be registered before '/:id/review' so "bulk" isn't matched as
// an :id. Authorized per-item in the controller via isGroupAdminOf.
router.put('/bulk/review', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new AccessRequestController(req, res, next);
  controller.reviewRequestsBulk(req, res, next).catch(next);
});

// Renew (extend) access the caller already holds in a group. Static path, so no
// conflict with POST '/'. Authorized in the service (caller must hold active access).
router.post('/renew', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new AccessRequestController(req, res, next);
  controller.renewAccess(req, res, next).catch(next);
});

router.get('/my', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new AccessRequestController(req, res, next);
  controller.getMyRequests(req, res, next).catch(next);
});

// Authorized in the controller (super → all; platform admin → their platform's
// groups; group admin → their groups), so requireRole can't express it here.
router.get('/pending', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new AccessRequestController(req, res, next);
  controller.getPendingRequests(req, res, next).catch(next);
});

router.get('/:id', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new AccessRequestController(req, res, next);
  controller.getRequestDetail(req, res, next).catch(next);
});

// Authorized in the controller via isGroupAdminOf (super, platform-admin-of-platform,
// or group-admin-of-group), which requireRole can't express.
router.put('/:id/review', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new AccessRequestController(req, res, next);
  controller.reviewRequest(req, res, next).catch(next);
});

export default router;
