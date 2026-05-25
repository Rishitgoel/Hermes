import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import prisma from '../config/prisma';
import accessWorkflowService from '../services/access-workflow.service';
import { AuthorizationError, NotFoundError } from '../utils/errors';

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
      const groupId = this.params.groupId as string;
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
        if (adminEntry) isAuthorized = true;
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
      const id = this.params.id as string;
      const { reason } = this.body;
      const userId = this.getUserId();
      if (!userId) return;

      // 1. Fetch user access record to identify group
      const access = await prisma.userAccess.findUnique({
        where: { id },
      });

      if (!access) {
        throw new NotFoundError('Active access record not found');
      }

      // 2. Authorization Check: Super Admin or Group Admin of the group
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
        if (adminEntry) isAuthorized = true;
      }

      if (!isAuthorized) {
        throw new AuthorizationError('You do not have permission to revoke access in this group');
      }

      const revoker = {
        id: userId,
        username: this.user!.username,
      };

      const updatedAccess = await accessWorkflowService.revokeAccess(id, revoker, reason);
      this.sendResponse(updatedAccess, 'Access revoked successfully');
    } catch (error) {
      this.handleError(error, 'Failed to revoke access');
    }
  }
}
