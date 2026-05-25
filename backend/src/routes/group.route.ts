import { Router, Request, Response, NextFunction } from 'express';
import { GroupController } from '../controllers/group.controller';
import { authenticateToken } from '../middleware/auth.middleware';

const router = Router();

router.get('/', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const groupController = new GroupController(req, res, next);
  groupController.getGroups(req, res, next).catch(next);
});

router.get('/:slug', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const groupController = new GroupController(req, res, next);
  groupController.getGroupDetail(req, res, next).catch(next);
});

export default router;
