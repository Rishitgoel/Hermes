import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import userCreationService from '../services/user-creation.service';
import accessWorkflowService from '../services/access-workflow.service';
import { computeAdminScopes, getDirectGroupAdminSlugs, AdminScopes } from '../utils/authz';
import { UserCreationStatus } from '@prisma/client';
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
      // Computed up-front because the auto-enrollment below keys off it.
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

      // Auto-enroll admins as REAL members of the groups they administer. This is
      // the one place with both their resolved admin scopes and a finalized Redash
      // account, so we do it lazily here. Fire-and-forget: it provisions on Redash
      // and shouldn't delay the session response.
      // Only runs once the Redash account is COMPLETED.
      //
      //   - group admins    → the group(s) they administer
      //   - platform admins: none. They manage platform groups without mass-provisioning.
      //   - super admins    → none. They get the cosmetic ACTIVE badge everywhere
      //                       (see group.controller) but are deliberately NOT mass-
      //                       provisioned into every group on every platform.
      //
      // adminScopes.groups also contains platform-admin groups for UI/request
      // scoping, so the provisioning set below uses direct GroupAdmin rows only.
      // Idempotent: enrollment skips any group the user is already a member of.
      const userCreationStatus = (userCreation as { status?: UserCreationStatus } | null)?.status;
      if (userCreationStatus === UserCreationStatus.COMPLETED) {
        const enrollUser = { id: this.user.id, username: this.user.username, email: this.user.email };
        const directGroupSlugs = await getDirectGroupAdminSlugs(this.user);
        accessWorkflowService
          .ensureGroupAdminEnrollment(enrollUser, directGroupSlugs, 'Group-admin auto-enrollment')
          .catch((err: any) => {
            logger.error(
              { err: err.message, userId: enrollUser.id },
              'ensureGroupAdminEnrollment failed in /auth/me',
            );
          });
      }

      this.sendResponse(
        { ...this.user, userCreation, adminScopes },
        'Session authenticated successfully',
      );
    } catch (error) {
      this.handleError(error, 'Failed to authenticate session');
    }
  }
}

export default AuthController;
