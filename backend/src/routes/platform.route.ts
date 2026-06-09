import { Router, Request, Response, NextFunction } from 'express';
import { PlatformController } from '../controllers/platform.controller';
import { authenticateToken } from '../middleware/auth.middleware';

const router = Router();

// Any authenticated user — the live-platform list isn't sensitive, but the grid
// that consumes it is behind auth, so keep it consistent.
router.get('/', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  const controller = new PlatformController(req, res, next);
  controller.list(req, res, next).catch(next);
});

export default router;
