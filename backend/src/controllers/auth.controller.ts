import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import prisma from '../config/prisma';
import userCreationService from '../services/user-creation.service';
import { computeAdminScopes, AdminScopes } from '../utils/authz';
import logger from '../utils/logger';

export class AuthController extends BaseController {
  // GET /auth/me
  // Returns the authenticated user plus their UserCreationRequest summary.
  // ensureDraftForUser is called here as the explicit, lazy auto-create hook —
  // we want exactly one row per Keycloak user, created lazily on first session load.
  async getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!this.user) {
        this.sendErrorResponse('User session not found', 401);
        return;
      }

      let userCreation: unknown = null;
      try {
        const row = await userCreationService.ensureDraftForUser({
          id: this.user.id,
          username: this.user.username,
          email: this.user.email,
        });
        userCreation = {
          id: row.id,
          platform: row.platform,
          status: row.status,
          justification: row.justification,
          submittedAt: row.submittedAt,
          approvedAt: row.approvedAt,
          inviteSentAt: row.inviteSentAt,
          inviteError: row.inviteError,
          inviteLink: row.inviteLink,
          completedAt: row.completedAt,
          externalUserId: row.externalUserId,
          rejectionReason: row.rejectionReason,
          reviewerName: row.reviewerName,
          reviewedAt: row.reviewedAt,
        };
      } catch (err: any) {
        // Don't fail /auth/me if the user-creation lookup blows up — log and continue.
        logger.error({ err: err.message, userId: this.user.id }, 'ensureDraftForUser failed in /auth/me');
      }

      // Resolve admin scopes (super / platform / group) so the frontend can gate
      // nav + scope the Admin Management UI without guessing from role strings.
      // Default to "no admin powers" if the lookup fails — never block /auth/me.
      let adminScopes: AdminScopes = {
        superAdmin: this.user.roles.includes('hermes_super_admin'),
        platforms: [],
        groups: [],
      };
      try {
        adminScopes = await computeAdminScopes(this.user);
      } catch (err: any) {
        logger.error({ err: err.message, userId: this.user.id }, 'computeAdminScopes failed in /auth/me');
      }

      // Whether to show the ZooKeeper Config page: gated on ZooKeeper group membership
      // (an active grant on a `platform='zookeeper'` group). Admins are members too —
      // they hold a grant on a ZK group like anyone. Wrapped so a failure never blocks
      // /auth/me. (Pure ZK admins review change requests from Pending Approvals, which
      // has its own admin gate.)
      let hasZookeeperAccess = false;
      try {
        hasZookeeperAccess =
          (await prisma.userAccess.count({
            where: { userId: this.user.id, isActive: true, group: { platform: 'zookeeper' } },
          })) > 0;
      } catch (err: any) {
        logger.error({ err: err.message, userId: this.user.id }, 'hasZookeeperAccess check failed in /auth/me');
      }

      this.sendResponse(
        { ...this.user, userCreation, adminScopes, hasZookeeperAccess },
        'Session authenticated successfully',
      );
    } catch (error) {
      this.handleError(error, 'Failed to authenticate session');
    }
  }
}

export default AuthController;
