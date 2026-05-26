import { Router, Request, Response, NextFunction } from 'express';
import { UserAccessController } from '../controllers/user-access.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

router.get('/me', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new UserAccessController(req, res, next);
  controller.getMyAccess(req, res, next).catch(next);
});

router.get('/group/:groupId', authenticateToken, requireRole(['atlas_super_admin', 'atlas_group_admin']), (req: Request, res: Response, next: NextFunction) => {
  const controller = new UserAccessController(req, res, next);
  controller.getGroupAccessList(req, res, next).catch(next);
});

router.delete('/:id', authenticateToken, requireRole(['atlas_super_admin', 'atlas_group_admin']), (req: Request, res: Response, next: NextFunction) => {
  const controller = new UserAccessController(req, res, next);
  controller.revokeAccess(req, res, next).catch(next);
});

router.get('/platform-status/:platform', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new UserAccessController(req, res, next);
  controller.getPlatformStatus(req, res, next).catch(next);
});

router.post('/platform-user/:platform', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new UserAccessController(req, res, next);
  controller.invitePlatformUser(req, res, next).catch(next);
});

export default router;
