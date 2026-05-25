"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccessRequestController = void 0;
const base_controller_1 = __importDefault(require("./base.controller"));
const prisma_1 = __importDefault(require("../config/prisma"));
const access_workflow_service_1 = __importDefault(require("../services/access-workflow.service"));
const access_request_validation_1 = require("../validations/access-request.validation");
const client_1 = require("@prisma/client");
const errors_1 = require("../utils/errors");
class AccessRequestController extends base_controller_1.default {
    // POST /api/access-requests
    async createRequest(req, res, next) {
        try {
            const validated = this.validateWithZod(access_request_validation_1.createRequestSchema, this.body);
            if (!validated.success)
                return;
            const userId = this.getUserId();
            if (!userId)
                return;
            const requester = {
                id: userId,
                username: this.user.username,
                email: this.user.email,
            };
            const { groupId, justification, duration } = validated.data;
            const request = await access_workflow_service_1.default.createRequest(requester, groupId, justification, duration);
            this.sendResponse(request, 'Access request submitted successfully', 201);
        }
        catch (error) {
            this.handleError(error, 'Failed to create access request');
        }
    }
    // GET /api/access-requests/my
    async getMyRequests(req, res, next) {
        try {
            const userId = this.getUserId();
            if (!userId)
                return;
            const requests = await prisma_1.default.accessRequest.findMany({
                where: { requesterId: userId },
                include: { group: true },
                orderBy: { createdAt: 'desc' },
            });
            this.sendResponse(requests, 'My requests retrieved successfully');
        }
        catch (error) {
            this.handleError(error, 'Failed to retrieve your request history');
        }
    }
    // GET /api/access-requests/pending
    async getPendingRequests(req, res, next) {
        try {
            const userId = this.getUserId();
            if (!userId)
                return;
            const isSuperAdmin = this.user.roles.includes('atlas_super_admin');
            const isGroupAdmin = this.user.roles.includes('atlas_group_admin');
            if (!isSuperAdmin && !isGroupAdmin) {
                throw new errors_1.AuthorizationError('Only admins can view pending requests');
            }
            let requests;
            if (isSuperAdmin) {
                // Super admin sees all pending requests
                requests = await prisma_1.default.accessRequest.findMany({
                    where: { status: client_1.RequestStatus.PENDING },
                    include: { group: true },
                    orderBy: { createdAt: 'desc' },
                });
            }
            else {
                // Group admin sees requests only for groups they manage
                const adminGroups = await prisma_1.default.groupAdmin.findMany({
                    where: { userId },
                    select: { groupId: true },
                });
                const groupIds = adminGroups.map(ag => ag.groupId);
                requests = await prisma_1.default.accessRequest.findMany({
                    where: {
                        status: client_1.RequestStatus.PENDING,
                        groupId: { in: groupIds },
                    },
                    include: { group: true },
                    orderBy: { createdAt: 'desc' },
                });
            }
            this.sendResponse(requests, 'Pending requests retrieved successfully');
        }
        catch (error) {
            this.handleError(error, 'Failed to retrieve pending requests');
        }
    }
    // GET /api/access-requests/:id
    async getRequestDetail(req, res, next) {
        try {
            const id = this.params.id;
            const userId = this.getUserId();
            if (!userId)
                return;
            const request = await prisma_1.default.accessRequest.findUnique({
                where: { id },
                include: { group: true },
            });
            if (!request) {
                throw new errors_1.NotFoundError('Access request not found');
            }
            // Authorization Check: Must be requester, super_admin, or admin of the request's group
            const isRequester = request.requesterId === userId;
            const isSuperAdmin = this.user.roles.includes('atlas_super_admin');
            let isGroupAdminOfRequest = false;
            if (this.user.roles.includes('atlas_group_admin')) {
                const adminEntry = await prisma_1.default.groupAdmin.findUnique({
                    where: {
                        groupId_userId: {
                            groupId: request.groupId,
                            userId: userId,
                        },
                    },
                });
                if (adminEntry)
                    isGroupAdminOfRequest = true;
            }
            if (!isRequester && !isSuperAdmin && !isGroupAdminOfRequest) {
                throw new errors_1.AuthorizationError('You are not authorized to view this request');
            }
            this.sendResponse(request, 'Access request retrieved successfully');
        }
        catch (error) {
            this.handleError(error, 'Failed to retrieve request details');
        }
    }
    // PUT /api/access-requests/:id/review
    async reviewRequest(req, res, next) {
        try {
            const id = this.params.id;
            const validated = this.validateWithZod(access_request_validation_1.reviewRequestSchema, this.body);
            if (!validated.success)
                return;
            const userId = this.getUserId();
            if (!userId)
                return;
            // 1. Fetch request to check group
            const request = await prisma_1.default.accessRequest.findUnique({
                where: { id },
            });
            if (!request) {
                throw new errors_1.NotFoundError('Access request not found');
            }
            // 2. Authorization Check: Super Admin or Group Admin of this group
            const isSuperAdmin = this.user.roles.includes('atlas_super_admin');
            let isAuthorized = isSuperAdmin;
            if (!isAuthorized && this.user.roles.includes('atlas_group_admin')) {
                const adminEntry = await prisma_1.default.groupAdmin.findUnique({
                    where: {
                        groupId_userId: {
                            groupId: request.groupId,
                            userId: userId,
                        },
                    },
                });
                if (adminEntry)
                    isAuthorized = true;
            }
            if (!isAuthorized) {
                throw new errors_1.AuthorizationError('You do not have permission to review requests for this group');
            }
            const { status, note } = validated.data;
            const reviewer = {
                id: userId,
                username: this.user.username,
            };
            const updatedRequest = await access_workflow_service_1.default.reviewRequest(id, reviewer, status, note);
            this.sendResponse(updatedRequest, `Access request reviewed: ${status}`);
        }
        catch (error) {
            this.handleError(error, 'Failed to review access request');
        }
    }
}
exports.AccessRequestController = AccessRequestController;
