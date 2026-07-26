import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import apolloUserService from '../services/apollo-user.service';
import { isSuperAdmin } from '../utils/authz';
import { AuthorizationError } from '../utils/errors';
import {
  createApolloUserSchema,
  resendApolloPasswordSchema,
} from '../validations/apollo-user.validation';

/**
 * Apollo login provisioning — super admin only.
 *
 * The route already gates on `hermes_super_admin` via requireRole; the explicit
 * check here is defence in depth for the one endpoint in Hermes that can mint a
 * brand-new credential, so a future route-wiring mistake can't quietly widen it.
 */
export class ApolloUserController extends BaseController {
  private assertSuperAdmin(): void {
    if (!isSuperAdmin(this.user!)) {
      throw new AuthorizationError(
        'Only super admins can create Apollo logins',
      );
    }
  }

  // POST /api/apollo-users
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      this.assertSuperAdmin();

      const validated = this.validateWithZod(
        createApolloUserSchema,
        this.req.body,
      );
      if (!validated.success) {
        return;
      }

      const userId = this.getUserId();
      if (!userId) {
        return;
      }

      const result = await apolloUserService.createUser(
        { id: userId, username: this.user!.username },
        validated.data,
      );

      this.sendResponse(result, 'Apollo login created', 201);
    } catch (error) {
      this.handleError(error, 'Failed to create Apollo login');
    }
  }

  // POST /api/apollo-users/resend-password — mint a fresh temporary password for
  // an existing Hermes-created login and re-deliver it. Recovery path for a DM
  // that never landed.
  async resendPassword(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      this.assertSuperAdmin();

      const validated = this.validateWithZod(
        resendApolloPasswordSchema,
        this.req.body,
      );
      if (!validated.success) {
        return;
      }

      const userId = this.getUserId();
      if (!userId) {
        return;
      }

      const result = await apolloUserService.regeneratePassword(
        { id: userId, username: this.user!.username },
        validated.data.email,
      );

      this.sendResponse(result, 'Temporary password regenerated');
    } catch (error) {
      this.handleError(error, 'Failed to regenerate the temporary password');
    }
  }
}

export default ApolloUserController;
