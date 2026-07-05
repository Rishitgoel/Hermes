import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import prisma from '../config/prisma';
import secretIngestionService from '../services/secret-ingestion.service';
import { AuthorizationError, NotFoundError } from '../utils/errors';
import { submitIngestionSchema, reviewIngestionSchema } from '../validations/secret-ingestion.validation';

/**
 * Controller for approval-gated Secret Ingestion workflows.
 */
export class SecretIngestionController extends BaseController {
  // GET /api/secrets/scope
  async getScope(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;
      const scope = await secretIngestionService.getUserScope(userId);
      this.sendResponse(scope, 'Secret scope retrieved');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve secret scope');
    }
  }

  // GET /api/secrets/keys?name=payment/gateway
  async listKeys(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;
      const secretName = ((this.req.query.name as string) || '').trim();
      const result = await secretIngestionService.listSecretKeys(userId, secretName);
      this.sendResponse(result, 'Secret keys retrieved');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve secret keys');
    }
  }

  // POST /api/secrets/requests
  async submitRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = this.validateWithZod(submitIngestionSchema, this.req.body);
      if (!validated.success) return;
      const userId = this.getUserId();
      if (!userId) return;
      const row = await secretIngestionService.createIngestionRequest({
        requester: this.user!,
        secretName: validated.data.secretName,
        entries: validated.data.entries,
        justification: validated.data.justification,
      });
      this.sendResponse(row, 'Secret ingestion request submitted', 201);
    } catch (error) {
      this.handleError(error, 'Failed to submit secret ingestion request');
    }
  }

  // GET /api/secrets/requests?scope=mine|review
  async listRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;
      const scope = this.req.query.scope === 'review' ? 'review' : 'mine';
      const rows = await secretIngestionService.listIngestionRequests(this.user!, scope);
      this.sendResponse(rows, 'Secret ingestion requests retrieved');
    } catch (error) {
      this.handleError(error, 'Failed to list secret ingestion requests');
    }
  }

  // PUT /api/secrets/requests/:id/review
  async reviewRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = this.validateWithZod(reviewIngestionSchema, this.req.body);
      if (!validated.success) return;
      const userId = this.getUserId();
      if (!userId) return;
      const id = this.req.params.id as string;

      const row = await prisma.secretIngestionRequest.findUnique({
        where: { id },
        select: { groupId: true },
      });
      if (!row) throw new NotFoundError('Secret ingestion request not found');
      if (!(await secretIngestionService.canReview(this.user!, row))) {
        throw new AuthorizationError('You do not have permission to review this secret ingestion request.');
      }

      const reviewer = { id: userId, username: this.user!.username };
      const updated = await secretIngestionService.reviewIngestionRequest(
        id,
        reviewer,
        validated.data.decisions,
        validated.data.note,
      );
      this.sendResponse(updated, 'Secret ingestion request reviewed');
    } catch (error) {
      this.handleError(error, 'Failed to review secret ingestion request');
    }
  }
}
