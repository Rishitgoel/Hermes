import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import prisma from '../config/prisma';
import accessWorkflowService from '../services/access-workflow.service';
import { createRequestSchema, reviewRequestSchema } from '../validations/access-request.validation';
import { RequestStatus } from '@prisma/client';
import { ValidationError, AuthorizationError, NotFoundError } from '../utils/errors';
import { getAdminGroupSlugsFromRoles } from '../middleware/auth.middleware';
import { isGroupAdminOf, isSuperAdmin } from '../utils/authz';

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

      // Prevent self-requesting if the caller already administers this group.
      if (await isGroupAdminOf(this.user!, groupId)) {
        throw new ValidationError('You are an admin of this group and already have active access by default.');
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

      const superAdmin = isSuperAdmin(this.user!);
      const isGroupAdmin = this.user!.roles.includes('atlas_group_admin');

      if (!superAdmin && !isGroupAdmin) {
        throw new AuthorizationError('Only admins can view pending requests');
      }

      let requests;
      if (superAdmin) {
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
      const canAdminister =
        isRequester || (await isGroupAdminOf(this.user!, request.groupId, request.group?.slug));

      if (!canAdminister) {
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

      if (!(await isGroupAdminOf(this.user!, request.groupId, request.group?.slug))) {
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
