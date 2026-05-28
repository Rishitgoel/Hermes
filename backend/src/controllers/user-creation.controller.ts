import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import userCreationService from '../services/user-creation.service';
import {
  submitUserCreationSchema,
  reviewUserCreationSchema,
} from '../validations/user-creation.validation';

export class UserCreationController extends BaseController {
  // POST /api/user-creation-requests — DRAFT → PENDING
  async submit(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = this.validateWithZod(submitUserCreationSchema, this.req.body);
      if (!validated.success) return;

      const userId = this.getUserId();
      if (!userId) return;

      const updated = await userCreationService.submitRequest(userId, validated.data.justification);
      this.sendResponse(updated, 'User-creation request submitted', 201);
    } catch (error) {
      this.handleError(error, 'Failed to submit user-creation request');
    }
  }

  // GET /api/user-creation-requests/me
  async getMine(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      const row = await userCreationService.getMyRequest(userId);
      this.sendResponse(row, 'User-creation request retrieved');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve user-creation request');
    }
  }

  // POST /api/user-creation-requests/me/resend
  async resendMine(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      const updated = await userCreationService.resendInvite(userId);
      this.sendResponse(updated, 'Redash invite resent');
    } catch (error) {
      this.handleError(error, 'Failed to resend invite');
    }
  }

  // POST /api/user-creation-requests/me/sync-now
  async syncMine(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      const updated = await userCreationService.forceSync(userId);
      this.sendResponse(updated, 'Sync completed');
    } catch (error) {
      this.handleError(error, 'Failed to run Redash sync');
    }
  }

  // GET /api/user-creation-requests/pending — admin
  async listPending(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rows = await userCreationService.listPending();
      this.sendResponse(rows, 'Pending user-creation requests retrieved');
    } catch (error) {
      this.handleError(error, 'Failed to list pending user-creation requests');
    }
  }

  // PUT /api/user-creation-requests/:id/review — admin
  async review(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = this.validateWithZod(reviewUserCreationSchema, this.req.body);
      if (!validated.success) return;

      const userId = this.getUserId();
      if (!userId) return;

      const id = this.req.params.id as string;
      const reviewer = { id: userId, username: this.user!.username };
      const updated = await userCreationService.reviewRequest(
        id,
        reviewer,
        validated.data.status,
        validated.data.note,
      );

      this.sendResponse(updated, `User-creation request ${validated.data.status}`);
    } catch (error) {
      this.handleError(error, 'Failed to review user-creation request');
    }
  }
}

export default UserCreationController;
