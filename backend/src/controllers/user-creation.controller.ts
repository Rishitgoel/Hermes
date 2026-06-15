import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import config from '../config/config';
import prisma from '../config/prisma';
import userCreationService from '../services/user-creation.service';
import { isSuperAdmin, isPlatformAdminOf, getManageablePlatforms } from '../utils/authz';
import { AuthorizationError, NotFoundError } from '../utils/errors';
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

  // GET /api/user-creation-requests/pending — super admin (all platforms) or
  // platform admin (their platform(s) only). Account creation is per-platform, so a
  // Redash platform admin reviews Redash account requests, AWS platform admin AWS, etc.
  async listPending(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Super admins see every platform (no filter); platform admins are scoped to
      // their mirror platforms. Anyone else (incl. pure group admins) has none → 403.
      if (isSuperAdmin(this.user!)) {
        const rows = await userCreationService.listPending();
        this.sendResponse(rows, 'Pending user-creation requests retrieved');
        return;
      }

      const platforms = await getManageablePlatforms(this.user!);
      if (platforms.length === 0) {
        throw new AuthorizationError('Only platform admins can review account requests');
      }

      const rows = await userCreationService.listPending(platforms);
      this.sendResponse(rows, 'Pending user-creation requests retrieved');
    } catch (error) {
      this.handleError(error, 'Failed to list pending user-creation requests');
    }
  }

  // PUT /api/user-creation-requests/:id/review — super admin, or platform admin of
  // the request's platform.
  async review(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = this.validateWithZod(reviewUserCreationSchema, this.req.body);
      if (!validated.success) return;

      const userId = this.getUserId();
      if (!userId) return;

      const id = this.req.params.id as string;

      // Authorize against the request's own platform: a platform admin may only
      // review account requests for the platform they administer.
      const row = await prisma.userCreationRequest.findUnique({
        where: { id },
        select: { platform: true },
      });
      if (!row) throw new NotFoundError('User-creation request not found');
      if (!(await isPlatformAdminOf(this.user!, row.platform))) {
        throw new AuthorizationError(
          'You do not have permission to review account requests for this platform',
        );
      }

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
