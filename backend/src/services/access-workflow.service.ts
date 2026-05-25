import prisma from '../config/prisma';
import redashService from './redash.service';
import notificationService from './notification.service';
import logger from '../utils/logger';
import { AccessDuration, RequestStatus } from '@prisma/client';
import { ValidationError, NotFoundError, ConflictError } from '../utils/errors';

export class AccessWorkflowService {
  private calculateExpiry(duration: AccessDuration): Date | null {
    const now = new Date();
    switch (duration) {
      case AccessDuration.ONE_DAY:
        return new Date(now.setDate(now.getDate() + 1));
      case AccessDuration.ONE_WEEK:
        return new Date(now.setDate(now.getDate() + 7));
      case AccessDuration.ONE_MONTH:
        return new Date(now.setMonth(now.getMonth() + 1));
      case AccessDuration.THREE_MONTHS:
        return new Date(now.setMonth(now.getMonth() + 3));
      case AccessDuration.PERMANENT:
      default:
        return null;
    }
  }

  // Create Request (User)
  async createRequest(
    requester: { id: string; username: string; email: string },
    groupId: string,
    justification: string,
    duration: AccessDuration
  ) {
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundError('Group not found');

    // Check if there is an active access
    const activeAccess = await prisma.userAccess.findFirst({
      where: {
        userId: requester.id,
        groupId: groupId,
        isActive: true,
      },
    });
    if (activeAccess) {
      throw new ConflictError('You already have active access to this group.');
    }

    // Check if there is a pending request
    const pendingRequest = await prisma.accessRequest.findFirst({
      where: {
        requesterId: requester.id,
        groupId: groupId,
        status: RequestStatus.PENDING,
      },
    });
    if (pendingRequest) {
      throw new ConflictError('You already have a pending request for this group.');
    }

    const expiresAt = this.calculateExpiry(duration);

    const request = await prisma.accessRequest.create({
      data: {
        groupId,
        requesterId: requester.id,
        requesterName: requester.username,
        requesterEmail: requester.email,
        justification,
        duration,
        expiresAt,
        status: RequestStatus.PENDING,
      },
    });

    // Create Audit Log
    await prisma.auditEntry.create({
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
    await notificationService.notifyRequestCreated(
      request.id,
      groupId,
      group.name,
      requester.username,
      justification,
      duration
    );

    return request;
  }

  // Review Request (Admin)
  async reviewRequest(
    requestId: string,
    reviewer: { id: string; username: string },
    status: 'APPROVED' | 'REJECTED',
    note?: string
  ) {
    const request = await prisma.accessRequest.findUnique({
      where: { id: requestId },
      include: { group: true },
    });

    if (!request) throw new NotFoundError('Access request not found');
    if (request.status !== RequestStatus.PENDING) {
      throw new ValidationError('Access request is already reviewed');
    }

    if (status === 'REJECTED') {
      const updatedRequest = await prisma.accessRequest.update({
        where: { id: requestId },
        data: {
          status: RequestStatus.REJECTED,
          reviewerId: reviewer.id,
          reviewerName: reviewer.username,
          reviewNote: note,
          reviewedAt: new Date(),
        },
      });

      // Audit Log
      await prisma.auditEntry.create({
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
      await notificationService.notifyRequestReviewed(
        request.requesterId,
        request.group.name,
        false,
        reviewer.username,
        note
      );

      return updatedRequest;
    }

    // Status: APPROVED -> Provisioning Workflow
    logger.info(`Starting Redash provisioning for request ${requestId}...`);
    
    // Update request state to PROVISIONING
    await prisma.accessRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.PROVISIONING,
        reviewerId: reviewer.id,
        reviewerName: reviewer.username,
        reviewNote: note,
        reviewedAt: new Date(),
      },
    });

    try {
      // 1. Get or invite Redash user
      const redashUserId = await redashService.findOrInviteUser(
        request.requesterEmail,
        request.requesterName
      );

      // 2. Add to Redash group
      const redashGroupId = request.group.externalGroupId
        ? parseInt(request.group.externalGroupId, 10)
        : null;

      if (!redashGroupId) {
        throw new Error(`Group ${request.group.name} has no associated Redash Group ID configured`);
      }

      await redashService.addUserToGroup(redashUserId, redashGroupId);

      // 3. Save UserAccess record
      const grantedAt = new Date();
      const userAccess = await prisma.userAccess.create({
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
      const finalRequest = await prisma.accessRequest.update({
        where: { id: requestId },
        data: {
          status: RequestStatus.PROVISIONED,
          provisionedAt: new Date(),
        },
      });

      // 5. Create Audit Log
      await prisma.auditEntry.create({
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
      await notificationService.notifyRequestReviewed(
        request.requesterId,
        request.group.name,
        true,
        reviewer.username,
        note
      );

      return finalRequest;
    } catch (err: any) {
      logger.error(`Provisioning failed for request ${requestId}:`, err.message);

      // Fallback request to PROVISION_FAILED
      await prisma.accessRequest.update({
        where: { id: requestId },
        data: {
          status: RequestStatus.PROVISION_FAILED,
          provisionError: err.message,
        },
      });

      // Audit Log
      await prisma.auditEntry.create({
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
  async revokeAccess(
    userAccessId: string,
    revoker: { id: string; username: string },
    reason?: string
  ) {
    const access = await prisma.userAccess.findUnique({
      where: { id: userAccessId },
      include: { group: true },
    });

    if (!access) throw new NotFoundError('User access grant not found');
    if (!access.isActive) throw new ValidationError('Access is already inactive');

    // 1. Remove from Redash Group
    const redashUserId = access.externalUserId ? parseInt(access.externalUserId, 10) : null;
    const redashGroupId = access.group.externalGroupId ? parseInt(access.group.externalGroupId, 10) : null;

    if (redashUserId && redashGroupId) {
      try {
        await redashService.removeUserFromGroup(redashUserId, redashGroupId);
      } catch (err: any) {
        logger.error(`Failed to remove user from Redash group during revocation of ${userAccessId}:`, err.message);
        // Continue database updates even if Redash client throws, to keep DB states syncable
      }
    }

    // 2. Disable UserAccess entry
    const updatedAccess = await prisma.userAccess.update({
      where: { id: userAccessId },
      data: {
        isActive: false,
        revokedAt: new Date(),
      },
    });

    // 3. Update Request status to REVOKED
    if (access.accessRequestId) {
      await prisma.accessRequest.update({
        where: { id: access.accessRequestId },
        data: {
          status: RequestStatus.REVOKED,
          revokeReason: reason,
          revokedAt: new Date(),
        },
      });
    }

    // 4. Audit Log
    await prisma.auditEntry.create({
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
    await notificationService.notifyAccessRevoked(
      access.userId,
      access.group.name,
      revoker.username,
      reason
    );

    return updatedAccess;
  }

  // Auto Expire Access (Scheduler Job)
  async expireAccess(userAccessId: string) {
    const access = await prisma.userAccess.findUnique({
      where: { id: userAccessId },
      include: { group: true },
    });

    if (!access || !access.isActive) return;

    logger.info(`Expiring temporary access grant ${userAccessId} for user ${access.userName} in group ${access.group.name}...`);

    // 1. Remove from Redash Group
    const redashUserId = access.externalUserId ? parseInt(access.externalUserId, 10) : null;
    const redashGroupId = access.group.externalGroupId ? parseInt(access.group.externalGroupId, 10) : null;

    if (redashUserId && redashGroupId) {
      try {
        await redashService.removeUserFromGroup(redashUserId, redashGroupId);
      } catch (err: any) {
        logger.error(`Scheduler failed to remove user from Redash group during expiry of ${userAccessId}:`, err.message);
      }
    }

    // 2. Disable UserAccess entry
    await prisma.userAccess.update({
      where: { id: userAccessId },
      data: {
        isActive: false,
        revokedAt: new Date(),
      },
    });

    // 3. Update request status to EXPIRED
    if (access.accessRequestId) {
      await prisma.accessRequest.update({
        where: { id: access.accessRequestId },
        data: {
          status: RequestStatus.EXPIRED,
          revokeReason: 'Auto-expired (time-bound grant ended)',
          revokedAt: new Date(),
        },
      });
    }

    // 4. Audit Log
    await prisma.auditEntry.create({
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
    await notificationService.notifyAccessExpired(access.userId, access.group.name);
  }
}

export const accessWorkflowService = new AccessWorkflowService();
export default accessWorkflowService;
