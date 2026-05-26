"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GroupController = void 0;
const base_controller_1 = __importDefault(require("./base.controller"));
const prisma_1 = __importDefault(require("../config/prisma"));
const client_1 = require("@prisma/client");
const auth_middleware_1 = require("../middleware/auth.middleware");
const group_validation_1 = require("../validations/group.validation");
class GroupController extends base_controller_1.default {
    // GET /api/groups
    async getGroups(req, res, next) {
        try {
            const userId = this.getUserId();
            if (!userId)
                return;
            const [groups, activeAccesses, pendingRequests] = await Promise.all([
                prisma_1.default.group.findMany({
                    where: { isActive: true },
                    include: {
                        admins: true,
                        _count: {
                            select: {
                                userAccesses: { where: { isActive: true } },
                            },
                        },
                    },
                    orderBy: { name: 'asc' },
                }),
                prisma_1.default.userAccess.findMany({
                    where: { userId, isActive: true },
                }),
                prisma_1.default.accessRequest.findMany({
                    where: { requesterId: userId, status: client_1.RequestStatus.PENDING },
                })
            ]);
            const isSuperAdmin = this.user?.roles.includes('atlas_super_admin') || false;
            const enrichedGroups = groups.map(g => {
                let accessStatus = 'NONE';
                const hasActive = activeAccesses.some(a => a.groupId === g.id);
                const hasPending = pendingRequests.some(r => r.groupId === g.id);
                const isKeycloakAdmin = this.user?.roles ? (0, auth_middleware_1.checkIsGroupAdmin)(this.user.roles, g.slug) : false;
                const isAdminOfGroup = g.admins.some(adm => adm.userId === userId) || isKeycloakAdmin;
                if (isSuperAdmin || isAdminOfGroup) {
                    accessStatus = 'ACTIVE';
                }
                else if (hasActive) {
                    accessStatus = 'ACTIVE';
                }
                else if (hasPending) {
                    accessStatus = 'PENDING';
                }
                return {
                    id: g.id,
                    name: g.name,
                    slug: g.slug,
                    description: g.description,
                    icon: g.icon,
                    color: g.color,
                    externalGroupId: g.externalGroupId,
                    tables: g.tables,
                    memberCount: g._count.userAccesses,
                    accessStatus,
                    admins: g.admins.map(adm => ({
                        userId: adm.userId,
                        userName: adm.userName,
                        userEmail: adm.userEmail,
                    })),
                };
            });
            this.sendResponse(enrichedGroups, 'Groups retrieved successfully');
        }
        catch (error) {
            this.handleError(error, 'Failed to retrieve groups');
        }
    }
    // GET /api/groups/:slug
    async getGroupDetail(req, res, next) {
        try {
            const slugResult = this.validateWithZod(group_validation_1.groupSlugSchema, this.req.params.slug, 'Invalid group slug');
            if (!slugResult.success)
                return;
            const slug = slugResult.data;
            const userId = this.getUserId();
            if (!userId)
                return;
            const group = await prisma_1.default.group.findUnique({
                where: { slug },
                include: {
                    admins: true,
                    userAccesses: {
                        where: { isActive: true },
                        orderBy: { grantedAt: 'desc' },
                    },
                },
            });
            if (!group) {
                this.sendErrorResponse('Group not found', 404);
                return;
            }
            // Check current user's status
            const activeAccess = await prisma_1.default.userAccess.findFirst({
                where: { userId, groupId: group.id, isActive: true },
            });
            const pendingRequest = await prisma_1.default.accessRequest.findFirst({
                where: { requesterId: userId, groupId: group.id, status: client_1.RequestStatus.PENDING },
            });
            const isSuperAdmin = this.user?.roles.includes('atlas_super_admin') || false;
            const isKeycloakAdmin = this.user?.roles ? (0, auth_middleware_1.checkIsGroupAdmin)(this.user.roles, group.slug) : false;
            const isAdminOfGroup = group.admins.some(adm => adm.userId === userId) || isKeycloakAdmin;
            let accessStatus = 'NONE';
            if (isSuperAdmin || isAdminOfGroup) {
                accessStatus = 'ACTIVE';
            }
            else if (activeAccess) {
                accessStatus = 'ACTIVE';
            }
            else if (pendingRequest) {
                accessStatus = 'PENDING';
            }
            const responseData = {
                id: group.id,
                name: group.name,
                slug: group.slug,
                description: group.description,
                icon: group.icon,
                color: group.color,
                externalGroupId: group.externalGroupId,
                tables: group.tables,
                accessStatus,
                admins: group.admins.map(adm => ({
                    userId: adm.userId,
                    userName: adm.userName,
                    userEmail: adm.userEmail,
                    assignedAt: adm.assignedAt,
                })),
                members: group.userAccesses.map(m => ({
                    id: m.id,
                    userId: m.userId,
                    userName: m.userName,
                    userEmail: m.userEmail,
                    grantedAt: m.grantedAt,
                    expiresAt: m.expiresAt,
                    grantedBy: m.grantedBy,
                })),
            };
            this.sendResponse(responseData, 'Group details retrieved successfully');
        }
        catch (error) {
            this.handleError(error, 'Failed to retrieve group details');
        }
    }
}
exports.GroupController = GroupController;
