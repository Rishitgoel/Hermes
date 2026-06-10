import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import config from '../config/config';
import userCreationService from '../services/user-creation.service';
import {
  submitUserCreationSchema,
  reviewUserCreationSchema,
} from '../validations/user-creation.validation';

export class UserCreationController extends BaseController {
  /** Resolve the target platform from query/body, defaulting to the login-default. */
  private platformParam(): string {
    const raw = (this.req.query.platform ?? this.req.body?.platform) as string | undefined;
    return (raw && raw.trim() ? raw : config.platform.default).toLowerCase();
  }

  // POST /api/user-creation-requests — DRAFT → PENDING (creates the row for
  // non-default platforms on first submit)
  async submit(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = this.validateWithZod(submitUserCreationSchema, this.req.body);
      if (!validated.success) return;

      const userId = this.getUserId();
      if (!userId) return;

      const platform = (validated.data.platform || config.platform.default).toLowerCase();
      const requester = { id: userId, username: this.user!.username, email: this.user!.email };
      const updated = await userCreationService.submitRequest(requester, validated.data.justification, platform);
      this.sendResponse(updated, 'User-creation request submitted', 201);
    } catch (error) {
      this.handleError(error, 'Failed to submit user-creation request');
    }
  }

  // GET /api/user-creation-requests/me?platform=redash|aws
  async getMine(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      const row = await userCreationService.getMyRequest(userId, this.platformParam());
      this.sendResponse(row, 'User-creation request retrieved');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve user-creation request');
    }
  }

  // GET /api/user-creation-requests/me/all — every platform's request for this user
  async getMineAll(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      const rows = await userCreationService.getMyRequests(userId);
      this.sendResponse(rows, 'User-creation requests retrieved');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve user-creation requests');
    }
  }

  // POST /api/user-creation-requests/me/resend
  async resendMine(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      const updated = await userCreationService.resendInvite(userId, this.platformParam());
      this.sendResponse(updated, 'Invite resent');
    } catch (error) {
      this.handleError(error, 'Failed to resend invite');
    }
  }

  // POST /api/user-creation-requests/me/sync-now
  async syncMine(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      const updated = await userCreationService.forceSync(userId, this.platformParam());
      this.sendResponse(updated, 'Sync completed');
    } catch (error) {
      this.handleError(error, 'Failed to run platform sync');
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
