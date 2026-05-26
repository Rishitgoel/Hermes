import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import prisma from '../config/prisma';
import accessWorkflowService from '../services/access-workflow.service';
import { createRequestSchema, reviewRequestSchema } from '../validations/access-request.validation';
import { RequestStatus } from '@prisma/client';
import { ValidationError, AuthorizationError, NotFoundError } from '../utils/errors';
import { checkIsGroupAdmin, getAdminGroupSlugsFromRoles } from '../middleware/auth.middleware';

export class AccessRequestController extends BaseController {
  // POST /api/access-requests
  async createRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = this.validateWithZod(createRequestSchema, this.req.body);
      if (!validated.success) return;

      const userId = this.getUserId();
      if (!userId) return;

      const requester = {
        id: userId,
        username: this.user!.username,
        email: this.user!.email,
      };

      const { groupId, justification, duration } = validated.data;

      // Check if user is superadmin or admin of this group (prevent self-requesting)
      const group = await prisma.group.findUnique({
        where: { id: groupId },
        select: { slug: true }
      });
      if (group) {
        const isSuperAdmin = this.user!.roles.includes('atlas_super_admin');
        const isKeycloakAdmin = checkIsGroupAdmin(this.user!.roles, group.slug);
        const dbAdmin = await prisma.groupAdmin.findFirst({
          where: { groupId, userId }
        });

        if (isSuperAdmin || isKeycloakAdmin || dbAdmin) {
          throw new ValidationError('You are an admin of this group and already have active access by default.');
        }
      }

      const request = await accessWorkflowService.createRequest(
        requester,
        groupId,
        justification,
        duration
      );

      this.sendResponse(request, 'Access request submitted successfully', 201);
    } catch (error) {
      this.handleError(error, 'Failed to create access request');
    }
  }

  // GET /api/access-requests/my
  async getMyRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      const requests = await prisma.accessRequest.findMany({
        where: { requesterId: userId },
        include: { group: true },
        orderBy: { createdAt: 'desc' },
      });

      this.sendResponse(requests, 'My requests retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve your request history');
    }
  }

  // GET /api/access-requests/pending
  async getPendingRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      const isSuperAdmin = this.user!.roles.includes('atlas_super_admin');
      const isGroupAdmin = this.user!.roles.includes('atlas_group_admin');

      if (!isSuperAdmin && !isGroupAdmin) {
        throw new AuthorizationError('Only admins can view pending requests');
      }

      let requests;
      if (isSuperAdmin) {
        // Super admin sees all pending requests
        requests = await prisma.accessRequest.findMany({
          where: { status: RequestStatus.PENDING },
          include: { group: true },
          orderBy: { createdAt: 'desc' },
        });
      } else {
        // Group admin sees requests only for groups they manage
        // 1. Database groups
        const adminGroups = await prisma.groupAdmin.findMany({
          where: { userId },
          select: { groupId: true },
        });
        const dbGroupIds = adminGroups.map(ag => ag.groupId);

        // 2. Keycloak groups
        const kcSlugs = getAdminGroupSlugsFromRoles(this.user!.roles || []);
        const kcGroups = await prisma.group.findMany({
          where: { slug: { in: kcSlugs } },
          select: { id: true },
        });
        const kcGroupIds = kcGroups.map(g => g.id);

        const groupIds = Array.from(new Set([...dbGroupIds, ...kcGroupIds]));

        requests = await prisma.accessRequest.findMany({
          where: {
            status: RequestStatus.PENDING,
            groupId: { in: groupIds },
          },
          include: { group: true },
          orderBy: { createdAt: 'desc' },
        });
      }

      this.sendResponse(requests, 'Pending requests retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve pending requests');
    }
  }

  // GET /api/access-requests/:id
  async getRequestDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = this.req.params.id as string;
      const userId = this.getUserId();
      if (!userId) return;

      const request = await prisma.accessRequest.findUnique({
        where: { id },
        include: { group: true },
      });

      if (!request) {
        throw new NotFoundError('Access request not found');
      }

      // Authorization Check: Must be requester, super_admin, or admin of the request's group
      const isRequester = request.requesterId === userId;
      const isSuperAdmin = this.user!.roles.includes('atlas_super_admin');
      
      let isGroupAdminOfRequest = false;
      if (this.user!.roles.includes('atlas_group_admin')) {
        const adminEntry = await prisma.groupAdmin.findUnique({
          where: {
            groupId_userId: {
              groupId: request.groupId,
              userId: userId,
            },
          },
        });
        if (adminEntry) {
          isGroupAdminOfRequest = true;
        } else if (request.group && checkIsGroupAdmin(this.user!.roles, request.group.slug)) {
          isGroupAdminOfRequest = true;
        }
      }

      if (!isRequester && !isSuperAdmin && !isGroupAdminOfRequest) {
        throw new AuthorizationError('You are not authorized to view this request');
      }

      this.sendResponse(request, 'Access request retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve request details');
    }
  }

  // PUT /api/access-requests/:id/review
  async reviewRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = this.req.params.id as string;
      const validated = this.validateWithZod(reviewRequestSchema, this.req.body);
      if (!validated.success) return;

      const userId = this.getUserId();
      if (!userId) return;

      // 1. Fetch request to check group
      const request = await prisma.accessRequest.findUnique({
        where: { id },
        include: { group: true },
      });
      if (!request) {
        throw new NotFoundError('Access request not found');
      }

      // 2. Authorization Check: Super Admin or Group Admin of this group
      const isSuperAdmin = this.user!.roles.includes('atlas_super_admin');
      let isAuthorized = isSuperAdmin;

      if (!isAuthorized && this.user!.roles.includes('atlas_group_admin')) {
        const adminEntry = await prisma.groupAdmin.findUnique({
          where: {
            groupId_userId: {
              groupId: request.groupId,
              userId: userId,
            },
          },
        });
        if (adminEntry) {
          isAuthorized = true;
        } else if (request.group && checkIsGroupAdmin(this.user!.roles, request.group.slug)) {
          isAuthorized = true;
        }
      }

      if (!isAuthorized) {
        throw new AuthorizationError('You do not have permission to review requests for this group');
      }

      const { status, note } = validated.data;
      const reviewer = {
        id: userId,
        username: this.user!.username,
      };

      const updatedRequest = await accessWorkflowService.reviewRequest(
        id,
        reviewer,
        status,
        note
      );

      this.sendResponse(updatedRequest, `Access request reviewed: ${status}`);
    } catch (error) {
      this.handleError(error, 'Failed to review access request');
    }
  }
}
