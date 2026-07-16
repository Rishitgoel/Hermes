import { Router, Request, Response, NextFunction } from 'express';
import { SecretIngestionController } from '../controllers/secret-ingestion.controller';
import { authenticateToken } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication; scoping/authorization is checked in the controller/service.

router.get(
  '/scope',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new SecretIngestionController(req, res, next)
      .getScope(req, res, next)
      .catch(next);
  },
);

router.get(
  '/keys',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new SecretIngestionController(req, res, next)
      .listKeys(req, res, next)
      .catch(next);
  },
);

router.post(
  '/requests/infra-preview',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new SecretIngestionController(req, res, next)
      .previewInfra(req, res, next)
      .catch(next);
  },
);

router.post(
  '/requests',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new SecretIngestionController(req, res, next)
      .submitRequest(req, res, next)
      .catch(next);
  },
);

router.post(
  '/requests/bulk',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new SecretIngestionController(req, res, next)
      .submitRequestsBulk(req, res, next)
      .catch(next);
  },
);

router.get(
  '/requests',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new SecretIngestionController(req, res, next)
      .listRequests(req, res, next)
      .catch(next);
  },
);

router.put(
  '/requests/:id/review',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new SecretIngestionController(req, res, next)
      .reviewRequest(req, res, next)
      .catch(next);
  },
);

router.post(
  '/requests/:id/retry-merge',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new SecretIngestionController(req, res, next)
      .retryMerge(req, res, next)
      .catch(next);
  },
);

router.post(
  '/requests/:id/dismiss-merge',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new SecretIngestionController(req, res, next)
      .dismissMerge(req, res, next)
      .catch(next);
  },
);

// Drift detection between AWS Secrets Manager and the infra-deployment manifests. Both are
// authenticateToken only; the drift service scopes to what the caller manages (empty otherwise).
router.get(
  '/drift',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new SecretIngestionController(req, res, next)
      .getDrift(req, res, next)
      .catch(next);
  },
);

router.post(
  '/drift/resolve',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new SecretIngestionController(req, res, next)
      .resolveDrift(req, res, next)
      .catch(next);
  },
);

router.post(
  '/drift/merge',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new SecretIngestionController(req, res, next)
      .mergeDrift(req, res, next)
      .catch(next);
  },
);

router.post(
  '/drift/ignore',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new SecretIngestionController(req, res, next)
      .ignoreDriftKey(req, res, next)
      .catch(next);
  },
);

router.post(
  '/drift/unignore',
  authenticateToken,
  (req: Request, res: Response, next: NextFunction) => {
    new SecretIngestionController(req, res, next)
      .unignoreDriftKey(req, res, next)
      .catch(next);
  },
);

export default router;
