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
const auth_middleware_1 = require("../middleware/auth.middleware");
const authz_1 = require("../utils/authz");
class AccessRequestController extends base_controller_1.default {
    // POST /api/access-requests
    async createRequest(req, res, next) {
        try {
            const validated = this.validateWithZod(access_request_validation_1.createRequestSchema, this.req.body);
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
            // Prevent self-requesting if the caller already administers this group.
            if (await (0, authz_1.isGroupAdminOf)(this.user, groupId)) {
                throw new errors_1.ValidationError('You are an admin of this group and already have active access by default.');
            }
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
            const superAdmin = (0, authz_1.isSuperAdmin)(this.user);
            const isGroupAdmin = this.user.roles.includes('hermes_group_admin');
            if (!superAdmin && !isGroupAdmin) {
                throw new errors_1.AuthorizationError('Only admins can view pending requests');
            }
            let requests;
            if (superAdmin) {
                // Super admin sees all pending requests
                requests = await prisma_1.default.accessRequest.findMany({
                    where: { status: client_1.RequestStatus.PENDING },
                    include: { group: true },
                    orderBy: { createdAt: 'desc' },
                });
            }
            else {
                // Group admin sees requests only for groups they manage
                // 1. Database groups
                const adminGroups = await prisma_1.default.groupAdmin.findMany({
                    where: { userId },
                    select: { groupId: true },
                });
                const dbGroupIds = adminGroups.map(ag => ag.groupId);
                // 2. Keycloak groups
                const kcSlugs = (0, auth_middleware_1.getAdminGroupSlugsFromRoles)(this.user.roles || []);
                const kcGroups = await prisma_1.default.group.findMany({
                    where: { slug: { in: kcSlugs } },
                    select: { id: true },
                });
                const kcGroupIds = kcGroups.map(g => g.id);
                const groupIds = Array.from(new Set([...dbGroupIds, ...kcGroupIds]));
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
            const id = this.req.params.id;
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
            const canAdminister = isRequester || (await (0, authz_1.isGroupAdminOf)(this.user, request.groupId, request.group?.slug));
            if (!canAdminister) {
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
            const id = this.req.params.id;
            const validated = this.validateWithZod(access_request_validation_1.reviewRequestSchema, this.req.body);
            if (!validated.success)
                return;
            const userId = this.getUserId();
            if (!userId)
                return;
            // 1. Fetch request to check group
            const request = await prisma_1.default.accessRequest.findUnique({
                where: { id },
                include: { group: true },
            });
            if (!request) {
                throw new errors_1.NotFoundError('Access request not found');
            }
            if (!(await (0, authz_1.isGroupAdminOf)(this.user, request.groupId, request.group?.slug))) {
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
