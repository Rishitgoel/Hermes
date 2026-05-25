import { Router, Request, Response, NextFunction } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { authenticateToken } from '../middleware/auth.middleware';

const router = Router();

router.get('/me', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const authController = new AuthController(req, res, next);
  authController.getMe(req, res, next).catch(next);
});

export default router;
