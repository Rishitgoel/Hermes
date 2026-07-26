import { Router, Request, Response, NextFunction } from 'express';
import { ApolloUserController } from '../controllers/apollo-user.controller';
import { authenticateToken, requireRole } from '../middleware/auth.middleware';

const router = Router();

// Every route here is super-admin-only: this is the one place in Hermes that can
// mint a brand-new Apollo login. The controller re-checks the tier as well.
router.post(
  '/',
  authenticateToken,
  requireRole(['hermes_super_admin']),
  (req: Request, res: Response, next: NextFunction) => {
    const controller = new ApolloUserController(req, res, next);
    controller.create(req, res, next).catch(next);
  },
);

// Recovery: regenerate + re-send the temporary password for an existing login.
// Scoped in the service to accounts Hermes itself created.
router.post(
  '/resend-password',
  authenticateToken,
  requireRole(['hermes_super_admin']),
  (req: Request, res: Response, next: NextFunction) => {
    const controller = new ApolloUserController(req, res, next);
    controller.resendPassword(req, res, next).catch(next);
  },
);

export default router;
