"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.accessWorkflowService = exports.AccessWorkflowService = void 0;
const prisma_1 = __importDefault(require("../config/prisma"));
const redash_service_1 = __importDefault(require("./redash.service"));
const notification_service_1 = __importDefault(require("./notification.service"));
const logger_1 = __importDefault(require("../utils/logger"));
const client_1 = require("@prisma/client");
const errors_1 = require("../utils/errors");
class AccessWorkflowService {
    calculateExpiry(duration) {
        const now = new Date();
        switch (duration) {
            case client_1.AccessDuration.ONE_DAY:
                return new Date(now.setDate(now.getDate() + 1));
            case client_1.AccessDuration.ONE_WEEK:
                return new Date(now.setDate(now.getDate() + 7));
            case client_1.AccessDuration.ONE_MONTH:
                return new Date(now.setMonth(now.getMonth() + 1));
            case client_1.AccessDuration.THREE_MONTHS:
                return new Date(now.setMonth(now.getMonth() + 3));
            case client_1.AccessDuration.PERMANENT:
            default:
                return null;
        }
    }
    // Create Request (User)
    async createRequest(requester, groupId, justification, duration) {
        const group = await prisma_1.default.group.findUnique({ where: { id: groupId } });
        if (!group)
            throw new errors_1.NotFoundError('Group not found');
        // Check if there is an active access
        const activeAccess = await prisma_1.default.userAccess.findFirst({
            where: {
                userId: requester.id,
                groupId: groupId,
                isActive: true,
            },
        });
        if (activeAccess) {
            throw new errors_1.ConflictError('You already have active access to this group.');
        }
        // Check if there is a pending request
        const pendingRequest = await prisma_1.default.accessRequest.findFirst({
            where: {
                requesterId: requester.id,
                groupId: groupId,
                status: client_1.RequestStatus.PENDING,
            },
        });
        if (pendingRequest) {
            throw new errors_1.ConflictError('You already have a pending request for this group.');
        }
        const expiresAt = this.calculateExpiry(duration);
        const request = await prisma_1.default.accessRequest.create({
            data: {
                groupId,
                requesterId: requester.id,
                requesterName: requester.username,
                requesterEmail: requester.email,
                justification,
                duration,
                expiresAt,
                status: client_1.RequestStatus.PENDING,
            },
        });
        // Create Audit Log
        await prisma_1.default.auditEntry.create({
            data: {
                action: 'REQUEST_CREATED',
                performerId: requester.id,
                performerName: requester.username,
                targetUserId: requester.id,
                targetUserName: requester.username,
                groupId,
                accessRequestId: request.id,
                details: { duration, expiresAt },
            },
        });
        // Notify admins
        await notification_service_1.default.notifyRequestCreated(request.id, groupId, group.name, requester.username, justification, duration);
        return request;
    }
    // Review Request (Admin)
    async reviewRequest(requestId, reviewer, status, note) {
        const request = await prisma_1.default.accessRequest.findUnique({
            where: { id: requestId },
            include: { group: true },
        });
        if (!request)
            throw new errors_1.NotFoundError('Access request not found');
        if (request.status !== client_1.RequestStatus.PENDING) {
            throw new errors_1.ValidationError('Access request is already reviewed');
        }
        if (status === 'REJECTED') {
            const updatedRequest = await prisma_1.default.accessRequest.update({
                where: { id: requestId },
                data: {
                    status: client_1.RequestStatus.REJECTED,
                    reviewerId: reviewer.id,
                    reviewerName: reviewer.username,
                    reviewNote: note,
                    reviewedAt: new Date(),
                },
            });
            // Audit Log
            await prisma_1.default.auditEntry.create({
                data: {
                    action: 'REQUEST_REJECTED',
                    performerId: reviewer.id,
                    performerName: reviewer.username,
                    targetUserId: request.requesterId,
                    targetUserName: request.requesterName,
                    groupId: request.groupId,
                    accessRequestId: requestId,
                    details: { note },
                },
            });
            // Notify user
            await notification_service_1.default.notifyRequestReviewed(request.requesterId, request.group.name, false, reviewer.username, note);
            return updatedRequest;
        }
        // Status: APPROVED -> Provisioning Workflow
        logger_1.default.info(`Starting Redash provisioning for request ${requestId}...`);
        // Update request state to PROVISIONING
        await prisma_1.default.accessRequest.update({
            where: { id: requestId },
            data: {
                status: client_1.RequestStatus.PROVISIONING,
                reviewerId: reviewer.id,
                reviewerName: reviewer.username,
                reviewNote: note,
                reviewedAt: new Date(),
            },
        });
        try {
            // 1. Get or invite Redash user
            const redashUserId = await redash_service_1.default.findOrInviteUser(request.requesterEmail, request.requesterName);
            // 2. Add to Redash group
            const redashGroupId = request.group.externalGroupId
                ? parseInt(request.group.externalGroupId, 10)
                : null;
            if (!redashGroupId) {
                throw new Error(`Group ${request.group.name} has no associated Redash Group ID configured`);
            }
            await redash_service_1.default.addUserToGroup(redashUserId, redashGroupId);
            // 3. Save UserAccess record
            const grantedAt = new Date();
            const userAccess = await prisma_1.default.userAccess.create({
                data: {
                    userId: request.requesterId,
                    userName: request.requesterName,
                    userEmail: request.requesterEmail,
                    groupId: request.groupId,
                    externalUserId: redashUserId.toString(),
                    isActive: true,
                    grantedAt,
                    expiresAt: request.expiresAt,
                    grantedBy: reviewer.username,
                    accessRequestId: request.id,
                },
            });
            // 4. Update request to PROVISIONED
            const finalRequest = await prisma_1.default.accessRequest.update({
                where: { id: requestId },
                data: {
                    status: client_1.RequestStatus.PROVISIONED,
                    provisionedAt: new Date(),
                },
            });
            // 5. Create Audit Log
            await prisma_1.default.auditEntry.create({
                data: {
                    action: 'ACCESS_GRANTED',
                    performerId: reviewer.id,
                    performerName: reviewer.username,
                    targetUserId: request.requesterId,
                    targetUserName: request.requesterName,
                    groupId: request.groupId,
                    accessRequestId: requestId,
                    details: {
                        userAccessId: userAccess.id,
                        redashUserId,
                        redashGroupId,
                        expiresAt: request.expiresAt,
                    },
                },
            });
            // 6. Notify Requester
            await notification_service_1.default.notifyRequestReviewed(request.requesterId, request.group.name, true, reviewer.username, note);
            return finalRequest;
        }
        catch (err) {
            logger_1.default.error(`Provisioning failed for request ${requestId}:`, err.message);
            // Fallback request to PROVISION_FAILED
            await prisma_1.default.accessRequest.update({
                where: { id: requestId },
                data: {
                    status: client_1.RequestStatus.PROVISION_FAILED,
                    provisionError: err.message,
                },
            });
            // Audit Log
            await prisma_1.default.auditEntry.create({
                data: {
                    action: 'PROVISION_FAILED',
                    performerId: reviewer.id,
                    performerName: reviewer.username,
                    targetUserId: request.requesterId,
                    targetUserName: request.requesterName,
                    groupId: request.groupId,
                    accessRequestId: requestId,
                    details: { error: err.message },
                },
            });
            throw err;
        }
    }
    // Revoke Access (Admin)
    async revokeAccess(userAccessId, revoker, reason) {
        const access = await prisma_1.default.userAccess.findUnique({
            where: { id: userAccessId },
            include: { group: true },
        });
        if (!access)
            throw new errors_1.NotFoundError('User access grant not found');
        if (!access.isActive)
            throw new errors_1.ValidationError('Access is already inactive');
        // 1. Remove from Redash Group
        const redashUserId = access.externalUserId ? parseInt(access.externalUserId, 10) : null;
        const redashGroupId = access.group.externalGroupId ? parseInt(access.group.externalGroupId, 10) : null;
        if (redashUserId && redashGroupId) {
            try {
                await redash_service_1.default.removeUserFromGroup(redashUserId, redashGroupId);
            }
            catch (err) {
                logger_1.default.error(`Failed to remove user from Redash group during revocation of ${userAccessId}:`, err.message);
                // Continue database updates even if Redash client throws, to keep DB states syncable
            }
        }
        // 2. Disable UserAccess entry
        const updatedAccess = await prisma_1.default.userAccess.update({
            where: { id: userAccessId },
            data: {
                isActive: false,
                revokedAt: new Date(),
            },
        });
        // 3. Update Request status to REVOKED
        if (access.accessRequestId) {
            await prisma_1.default.accessRequest.update({
                where: { id: access.accessRequestId },
                data: {
                    status: client_1.RequestStatus.REVOKED,
                    revokeReason: reason,
                    revokedAt: new Date(),
                },
            });
        }
        // 4. Audit Log
        await prisma_1.default.auditEntry.create({
            data: {
                action: 'ACCESS_REVOKED',
                performerId: revoker.id,
                performerName: revoker.username,
                targetUserId: access.userId,
                targetUserName: access.userName,
                groupId: access.groupId,
                accessRequestId: access.accessRequestId,
                details: { reason, userAccessId },
            },
        });
        // 5. Notify Requester
        await notification_service_1.default.notifyAccessRevoked(access.userId, access.group.name, revoker.username, reason);
        return updatedAccess;
    }
    // Auto Expire Access (Scheduler Job)
    async expireAccess(userAccessId) {
        const access = await prisma_1.default.userAccess.findUnique({
            where: { id: userAccessId },
            include: { group: true },
        });
        if (!access || !access.isActive)
            return;
        logger_1.default.info(`Expiring temporary access grant ${userAccessId} for user ${access.userName} in group ${access.group.name}...`);
        // 1. Remove from Redash Group
        const redashUserId = access.externalUserId ? parseInt(access.externalUserId, 10) : null;
        const redashGroupId = access.group.externalGroupId ? parseInt(access.group.externalGroupId, 10) : null;
        if (redashUserId && redashGroupId) {
            try {
                await redash_service_1.default.removeUserFromGroup(redashUserId, redashGroupId);
            }
            catch (err) {
                logger_1.default.error(`Scheduler failed to remove user from Redash group during expiry of ${userAccessId}:`, err.message);
            }
        }
        // 2. Disable UserAccess entry
        await prisma_1.default.userAccess.update({
            where: { id: userAccessId },
            data: {
                isActive: false,
                revokedAt: new Date(),
            },
        });
        // 3. Update request status to EXPIRED
        if (access.accessRequestId) {
            await prisma_1.default.accessRequest.update({
                where: { id: access.accessRequestId },
                data: {
                    status: client_1.RequestStatus.EXPIRED,
                    revokeReason: 'Auto-expired (time-bound grant ended)',
                    revokedAt: new Date(),
                },
            });
        }
        // 4. Audit Log
        await prisma_1.default.auditEntry.create({
            data: {
                action: 'ACCESS_EXPIRED',
                performerId: 'system_scheduler',
                performerName: 'System Scheduler',
                targetUserId: access.userId,
                targetUserName: access.userName,
                groupId: access.groupId,
                accessRequestId: access.accessRequestId,
                details: { userAccessId },
            },
        });
        // 5. Notify Requester
        await notification_service_1.default.notifyAccessExpired(access.userId, access.group.name);
    }
}
exports.AccessWorkflowService = AccessWorkflowService;
exports.accessWorkflowService = new AccessWorkflowService();
exports.default = exports.accessWorkflowService;
