"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserAccessController = void 0;
const base_controller_1 = __importDefault(require("./base.controller"));
const prisma_1 = __importDefault(require("../config/prisma"));
const access_workflow_service_1 = __importDefault(require("../services/access-workflow.service"));
const errors_1 = require("../utils/errors");
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
            const groupId = this.params.groupId;
            const userId = this.getUserId();
            if (!userId)
                return;
            // Authorization Check: Super Admin or Group Admin of this group
            const isSuperAdmin = this.user.roles.includes('atlas_super_admin');
            let isAuthorized = isSuperAdmin;
            if (!isAuthorized && this.user.roles.includes('atlas_group_admin')) {
                const adminEntry = await prisma_1.default.groupAdmin.findUnique({
                    where: {
                        groupId_userId: {
                            groupId,
                            userId: userId,
                        },
                    },
                });
                if (adminEntry)
                    isAuthorized = true;
            }
            if (!isAuthorized) {
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
            const id = this.params.id;
            const { reason } = this.body;
            const userId = this.getUserId();
            if (!userId)
                return;
            // 1. Fetch user access record to identify group
            const access = await prisma_1.default.userAccess.findUnique({
                where: { id },
            });
            if (!access) {
                throw new errors_1.NotFoundError('Active access record not found');
            }
            // 2. Authorization Check: Super Admin or Group Admin of the group
            const isSuperAdmin = this.user.roles.includes('atlas_super_admin');
            let isAuthorized = isSuperAdmin;
            if (!isAuthorized && this.user.roles.includes('atlas_group_admin')) {
                const adminEntry = await prisma_1.default.groupAdmin.findUnique({
                    where: {
                        groupId_userId: {
                            groupId: access.groupId,
                            userId: userId,
                        },
                    },
                });
                if (adminEntry)
                    isAuthorized = true;
            }
            if (!isAuthorized) {
                throw new errors_1.AuthorizationError('You do not have permission to revoke access in this group');
            }
            const revoker = {
                id: userId,
                username: this.user.username,
            };
            const updatedAccess = await access_workflow_service_1.default.revokeAccess(id, revoker, reason);
            this.sendResponse(updatedAccess, 'Access revoked successfully');
        }
        catch (error) {
            this.handleError(error, 'Failed to revoke access');
        }
    }
}
exports.UserAccessController = UserAccessController;
