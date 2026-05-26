import prisma from '../config/prisma';
import provisioningRegistry from './provisioning.registry';
import eventBus from './event-bus';
import logger from '../utils/logger';
import { AccessDuration, RequestStatus } from '@prisma/client';
import { ValidationError, NotFoundError, ConflictError } from '../utils/errors';

export class AccessWorkflowService {
  private calculateExpiry(duration: AccessDuration): Date | null {
    switch (duration) {
      case AccessDuration.ONE_DAY:
        return new Date(Date.now() + 1 * 24 * 60 * 60 * 1000);
      case AccessDuration.ONE_WEEK:
        return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      case AccessDuration.ONE_MONTH:
        {
          const d = new Date();
          d.setMonth(d.getMonth() + 1);
          return d;
        }
      case AccessDuration.THREE_MONTHS:
        {
          const d = new Date();
          d.setMonth(d.getMonth() + 3);
          return d;
        }
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

    // Notify admins via Event Bus
    eventBus.emitAccessEvent({
      type: 'request.created',
      payload: {
        requestId: request.id,
        groupId,
        groupName: group.name,
        requesterName: requester.username,
        justification,
        duration,
      },
      timestamp: new Date(),
    });

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

      // Notify user via Event Bus
      eventBus.emitAccessEvent({
        type: 'request.rejected',
        payload: {
          requesterId: request.requesterId,
          groupName: request.group.name,
          reviewerName: reviewer.username,
          note,
        },
        timestamp: new Date(),
      });

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
      const platform = request.group.platform || 'redash';
      const provisioner = provisioningRegistry.get(platform);
      
      const externalGroupId = request.group.externalGroupId;
      if (!externalGroupId) {
        throw new Error(`Group ${request.group.name} has no associated External Group ID configured`);
      }

      // Provision user and group access using new context shape
      const result = await provisioner.provision({
        email: request.requesterEmail,
        name: request.requesterName,
        externalGroupId,
      });
      const externalUserId = result.externalUserId;

      // 3. Save UserAccess record
      const grantedAt = new Date();
      const userAccess = await prisma.userAccess.create({
        data: {
          userId: request.requesterId,
          userName: request.requesterName,
          userEmail: request.requesterEmail,
          groupId: request.groupId,
          externalUserId: externalUserId,
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
            platform,
            externalUserId,
            externalGroupId,
            expiresAt: request.expiresAt,
          },
        },
      });

      // 6. Notify Requester via Event Bus
      eventBus.emitAccessEvent({
        type: 'request.approved',
        payload: {
          requesterId: request.requesterId,
          groupName: request.group.name,
          reviewerName: reviewer.username,
          note,
        },
        timestamp: new Date(),
      });

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
    reason?: string,
    force: boolean = false
  ) {
    const access = await prisma.userAccess.findUnique({
      where: { id: userAccessId },
      include: { group: true },
    });

    if (!access) throw new NotFoundError('User access grant not found');
    if (!access.isActive) throw new ValidationError('Access is already inactive');

    // 1. Remove from platform Group
    const externalUserId = access.externalUserId;
    const externalGroupId = access.group.externalGroupId;
    const platform = access.group.platform || 'redash';

    if (externalUserId && externalGroupId) {
      try {
        const provisioner = provisioningRegistry.get(platform.toLowerCase());
        await provisioner.deprovision({ externalUserId, externalGroupId });
      } catch (err: any) {
        logger.error(`Failed to deprovision user from platform ${platform} during revocation of ${userAccessId}:`, err.message);
        if (!force) {
          throw err;
        }
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

    // 5. Notify Requester via Event Bus
    eventBus.emitAccessEvent({
      type: 'access.revoked',
      payload: {
        userId: access.userId,
        groupName: access.group.name,
        revokerName: revoker.username,
        reason,
      },
      timestamp: new Date(),
    });

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

    // 1. Remove from platform Group
    const externalUserId = access.externalUserId;
    const externalGroupId = access.group.externalGroupId;
    const platform = access.group.platform || 'redash';

    if (externalUserId && externalGroupId) {
      try {
        const provisioner = provisioningRegistry.get(platform.toLowerCase());
        await provisioner.deprovision({ externalUserId, externalGroupId });
      } catch (err: any) {
        logger.error(`Scheduler failed to deprovision user from platform ${platform} during expiry of ${userAccessId}:`, err.message);
        throw err;
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

    // 5. Notify Requester via Event Bus
    eventBus.emitAccessEvent({
      type: 'access.expired',
      payload: {
        userId: access.userId,
        groupName: access.group.name,
      },
      timestamp: new Date(),
    });
  }
}

export const accessWorkflowService = new AccessWorkflowService();
export default accessWorkflowService;
