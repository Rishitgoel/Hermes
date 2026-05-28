"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserAccessController = void 0;
const base_controller_1 = __importDefault(require("./base.controller"));
const prisma_1 = __importDefault(require("../config/prisma"));
const access_workflow_service_1 = __importDefault(require("../services/access-workflow.service"));
const provisioning_registry_1 = __importDefault(require("../services/provisioning.registry"));
const errors_1 = require("../utils/errors");
const authz_1 = require("../utils/authz");
const platform_validation_1 = require("../validations/platform.validation");
class UserAccessController extends base_controller_1.default {
    // GET /api/user-access/me
    async getMyAccess(req, res, next) {
        try {
            const userId = this.getUserId();
            if (!userId)
                return;
            const accesses = await prisma_1.default.userAccess.findMany({
                where: { userId, isActive: true },
                include: { group: true },
                orderBy: { grantedAt: 'desc' },
            });
            this.sendResponse(accesses, 'My active accesses retrieved successfully');
        }
        catch (error) {
            this.handleError(error, 'Failed to retrieve active accesses');
        }
    }
    // GET /api/user-access/group/:groupId
    async getGroupAccessList(req, res, next) {
        try {
            const groupId = this.req.params.groupId;
            const userId = this.getUserId();
            if (!userId)
                return;
            if (!(await (0, authz_1.isGroupAdminOf)(this.user, groupId))) {
                throw new errors_1.AuthorizationError('You do not have permission to view this group member list');
            }
            const accesses = await prisma_1.default.userAccess.findMany({
                where: { groupId, isActive: true },
                orderBy: { userName: 'asc' },
            });
            this.sendResponse(accesses, 'Group members retrieved successfully');
        }
        catch (error) {
            this.handleError(error, 'Failed to retrieve group members');
        }
    }
    // DELETE /api/user-access/:id
    async revokeAccess(req, res, next) {
        try {
            const id = this.req.params.id;
            const { reason, force } = this.req.body;
            const userId = this.getUserId();
            if (!userId)
                return;
            // 1. Fetch user access record to identify group
            const access = await prisma_1.default.userAccess.findUnique({
                where: { id },
                include: { group: true },
            });
            if (!access) {
                throw new errors_1.NotFoundError('User access record not found');
            }
            if (!(await (0, authz_1.isGroupAdminOf)(this.user, access.groupId, access.group?.slug))) {
                throw new errors_1.AuthorizationError('You do not have permission to revoke access for this group');
            }
            const revoker = {
                id: userId,
                username: this.user.username,
            };
            const isForce = force === true || force === 'true';
            const updatedAccess = await access_workflow_service_1.default.revokeAccess(id, revoker, reason, isForce);
            this.sendResponse(updatedAccess, 'Access revoked successfully');
        }
        catch (error) {
            this.handleError(error, 'Failed to revoke access');
        }
    }
    // GET /api/user-access/platform-status/:platform
    async getPlatformStatus(req, res, next) {
        try {
            const platformResult = this.validateWithZod(platform_validation_1.PlatformEnum, this.req.params.platform, 'Invalid platform');
            if (!platformResult.success)
                return;
            const platform = platformResult.data;
            const email = this.user.email;
            if (!email) {
                this.sendResponse({ exists: false, email: '' }, 'Email not found in session');
                return;
            }
            const adapter = provisioning_registry_1.default.get(platform);
            const status = await adapter.checkUserStatus(email);
            this.sendResponse(status, `Platform status for ${platform} retrieved`);
        }
        catch (error) {
            this.handleError(error, 'Failed to retrieve platform user status');
        }
    }
    // POST /api/user-access/platform-user/:platform
    async invitePlatformUser(req, res, next) {
        try {
            const platformResult = this.validateWithZod(platform_validation_1.PlatformEnum, this.req.params.platform, 'Invalid platform');
            if (!platformResult.success)
                return;
            const platform = platformResult.data;
            const email = this.user.email;
            const name = this.user.username.replace(/_/g, ' ');
            if (!email) {
                this.sendErrorResponse('Email not found in user session', 400);
                return;
            }
            const adapter = provisioning_registry_1.default.get(platform);
            const result = await adapter.inviteUser(email, name);
            this.sendResponse({ success: true, ...result }, `${platform} user created/invited successfully`);
        }
        catch (error) {
            this.handleError(error, 'Failed to invite platform user');
        }
    }
}
exports.UserAccessController = UserAccessController;
