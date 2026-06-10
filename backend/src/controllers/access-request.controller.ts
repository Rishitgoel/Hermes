import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import prisma from '../config/prisma';
import accessWorkflowService from '../services/access-workflow.service';
import { createRequestSchema, reviewRequestSchema, changeLevelSchema } from '../validations/access-request.validation';
import { RequestStatus, Prisma } from '@prisma/client';
import { AuthorizationError, NotFoundError } from '../utils/errors';
import { isGroupAdminOf, computeAdminScopes } from '../utils/authz';

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

      const { groupId, levelId, justification, duration } = validated.data;

      // Admins (group/platform/super) are NOT blocked from requesting: the admin
      // role grants approval rights only, no data access — if an admin needs the
      // group's data they go through the same request → approval flow as anyone.
      const request = await accessWorkflowService.createRequest(
        requester,
        groupId,
        justification,
        duration,
        levelId
      );

      this.sendResponse(request, 'Access request submitted successfully', 201);
    } catch (error) {
      this.handleError(error, 'Failed to create access request');
    }
  }

  // POST /api/access-requests/change-level
  // Change the level the caller already holds in a group (promote/demote). The
  // service decides, by level rank, whether this is an instant self-service
  // demotion or a gated (admin-approval) promotion — and keeps the user on exactly
  // one level per group either way.
  async changeLevel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = this.validateWithZod(changeLevelSchema, this.req.body);
      if (!validated.success) return;

      const userId = this.getUserId();
      if (!userId) return;

      const requester = {
        id: userId,
        username: this.user!.username,
        email: this.user!.email,
      };

      const { groupId, levelId, justification, duration } = validated.data;

      // No admin guard here: an admin holding a real grant changes levels like any
      // member (the service itself rejects callers with no active grant).
      const result = await accessWorkflowService.changeLevel(
        requester,
        groupId,
        levelId,
        justification,
        duration
      );

      const message =
        result.kind === 'instant'
          ? 'Your level was changed and applied immediately.'
          : 'Level change request submitted for approval.';
      this.sendResponse(result, message, result.kind === 'instant' ? 200 : 201);
    } catch (error) {
      this.handleError(error, 'Failed to change level');
    }
  }

  // GET /api/access-requests/my
  async getMyRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      const requests = await prisma.accessRequest.findMany({
        where: { requesterId: userId },
        include: { group: true, level: true },
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

      // Mirror-authoritative scoping: super → all; platform admin → their
      // platform's groups; group admin → their groups (computeAdminScopes.groups
      // already unions both). Anyone else has no admin scope → 403.
      const scopes = await computeAdminScopes(this.user!);
      if (!scopes.superAdmin && scopes.platforms.length === 0 && scopes.groups.length === 0) {
        throw new AuthorizationError('Only admins can view pending requests');
      }

      const where: Prisma.AccessRequestWhereInput = { status: RequestStatus.PENDING };
      if (!scopes.superAdmin) {
        where.group = { slug: { in: scopes.groups } };
      }

      const requests = await prisma.accessRequest.findMany({
        where,
        include: { group: true, level: true },
        orderBy: { createdAt: 'desc' },
      });

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
        include: { group: true, level: true },
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
