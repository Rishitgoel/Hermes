import { Router, Request, Response, NextFunction } from 'express';
import { ZookeeperController } from '../controllers/zookeeper.controller';
import { authenticateToken } from '../middleware/auth.middleware';

const router = Router();

// All routes are authenticated; fine-grained authz (grant-scope / reviewer) is in the
// controller + service (the user-creation.route.ts pattern).

router.get(
  '/scope',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new ZookeeperController(req, res, next)
      .getScope(req, res, next)
      .catch(next);
  },
);

router.get(
  '/nodes',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new ZookeeperController(req, res, next)
      .browseNode(req, res, next)
      .catch(next);
  },
);

router.get(
  '/export',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new ZookeeperController(req, res, next)
      .exportSubtree(req, res, next)
      .catch(next);
  },
);

router.post(
  '/requests',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new ZookeeperController(req, res, next)
      .submitChangeRequest(req, res, next)
      .catch(next);
  },
);

router.get(
  '/requests',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new ZookeeperController(req, res, next)
      .listRequests(req, res, next)
      .catch(next);
  },
);

router.put(
  '/requests/:id/review',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new ZookeeperController(req, res, next)
      .reviewRequest(req, res, next)
      .catch(next);
  },
);

export default router;
