import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import prisma from '../config/prisma';
import accessWorkflowService from '../services/access-workflow.service';
import provisioningRegistry from '../services/provisioning.registry';
import { AuthorizationError, NotFoundError } from '../utils/errors';
import { checkIsGroupAdmin } from '../middleware/auth.middleware';
import { PlatformEnum } from '../validations/platform.validation';

export class UserAccessController extends BaseController {
  // GET /api/user-access/me
  async getMyAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      const accesses = await prisma.userAccess.findMany({
        where: { userId, isActive: true },
        include: { group: true },
        orderBy: { grantedAt: 'desc' },
      });

      this.sendResponse(accesses, 'My active accesses retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve active accesses');
    }
  }

  // GET /api/user-access/group/:groupId
  async getGroupAccessList(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = this.req.params.groupId as string;
      const userId = this.getUserId();
      if (!userId) return;

      // Authorization Check: Super Admin or Group Admin of this group
      const isSuperAdmin = this.user!.roles.includes('atlas_super_admin');
      let isAuthorized = isSuperAdmin;

      if (!isAuthorized && this.user!.roles.includes('atlas_group_admin')) {
        const adminEntry = await prisma.groupAdmin.findUnique({
          where: {
            groupId_userId: {
              groupId,
              userId: userId,
            },
          },
        });
        if (adminEntry) {
          isAuthorized = true;
        } else {
          const group = await prisma.group.findUnique({
            where: { id: groupId },
            select: { slug: true }
          });
          if (group && checkIsGroupAdmin(this.user!.roles, group.slug)) {
            isAuthorized = true;
          }
        }
      }

      if (!isAuthorized) {
        throw new AuthorizationError('You do not have permission to view this group member list');
      }

      const accesses = await prisma.userAccess.findMany({
        where: { groupId, isActive: true },
        orderBy: { userName: 'asc' },
      });

      this.sendResponse(accesses, 'Group members retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve group members');
    }
  }

  // DELETE /api/user-access/:id
  async revokeAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = this.req.params.id as string;
      const { reason, force } = this.req.body;
      const userId = this.getUserId();
      if (!userId) return;

      // 1. Fetch user access record to identify group
      const access = await prisma.userAccess.findUnique({
        where: { id },
        include: { group: true },
      });

      if (!access) {
        throw new NotFoundError('User access record not found');
      }

      // 2. Authorization Check: Super Admin, or Group Admin of this group
      const isSuperAdmin = this.user!.roles.includes('atlas_super_admin');
      let isAuthorized = isSuperAdmin;

      if (!isAuthorized && this.user!.roles.includes('atlas_group_admin')) {
        const adminEntry = await prisma.groupAdmin.findUnique({
          where: {
            groupId_userId: {
              groupId: access.groupId,
              userId: userId,
            },
          },
        });
        if (adminEntry) {
          isAuthorized = true;
        } else {
          if (access.group && checkIsGroupAdmin(this.user!.roles, access.group.slug)) {
            isAuthorized = true;
          }
        }
      }

      if (!isAuthorized) {
        throw new AuthorizationError('You do not have permission to revoke access for this group');
      }

      const revoker = {
        id: userId,
        username: this.user!.username,
      };

      const isForce = force === true || force === 'true';
      const updatedAccess = await accessWorkflowService.revokeAccess(id, revoker, reason, isForce);
      this.sendResponse(updatedAccess, 'Access revoked successfully');
    } catch (error) {
      this.handleError(error, 'Failed to revoke access');
    }
  }

  // GET /api/user-access/platform-status/:platform
  async getPlatformStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const platformResult = this.validateWithZod(PlatformEnum, this.req.params.platform, 'Invalid platform');
      if (!platformResult.success) return;
      const platform = platformResult.data;

      const email = this.user!.email;

      if (!email) {
        this.sendResponse({ exists: false, email: '' }, 'Email not found in session');
        return;
      }

      const adapter = provisioningRegistry.get(platform);
      const status = await adapter.checkUserStatus(email);
      this.sendResponse(status, `Platform status for ${platform} retrieved`);
    } catch (error) {
      this.handleError(error, 'Failed to retrieve platform user status');
    }
  }

  // POST /api/user-access/platform-user/:platform
  async invitePlatformUser(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const platformResult = this.validateWithZod(PlatformEnum, this.req.params.platform, 'Invalid platform');
      if (!platformResult.success) return;
      const platform = platformResult.data;

      const email = this.user!.email;
      const name = this.user!.username.replace(/_/g, ' ');

      if (!email) {
        this.sendErrorResponse('Email not found in user session', 400);
        return;
      }

      const adapter = provisioningRegistry.get(platform);
      const result = await adapter.inviteUser(email, name);
      this.sendResponse({ success: true, ...result }, `${platform} user created/invited successfully`);
    } catch (error) {
      this.handleError(error, 'Failed to invite platform user');
    }
  }
}
