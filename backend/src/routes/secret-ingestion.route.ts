import { Router, Request, Response, NextFunction } from 'express';
import { SecretIngestionController } from '../controllers/secret-ingestion.controller';
import { authenticateToken } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication; scoping/authorization is checked in the controller/service.

router.get('/scope', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  new SecretIngestionController(req, res, next).getScope(req, res, next).catch(next);
});

router.get('/keys', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  new SecretIngestionController(req, res, next).listKeys(req, res, next).catch(next);
});

router.post('/requests', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  new SecretIngestionController(req, res, next).submitRequest(req, res, next).catch(next);
});

router.get('/requests', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  new SecretIngestionController(req, res, next).listRequests(req, res, next).catch(next);
});

router.put('/requests/:id/review', authenticateToken, (req: Request, res: Response, next: NextFunction) => {
  new SecretIngestionController(req, res, next).reviewRequest(req, res, next).catch(next);
});

export default router;
