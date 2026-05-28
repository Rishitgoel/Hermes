import prisma from '../config/prisma';
import redashService from './redash.service';
import syncService from './sync.service';
import accessWorkflowService from './access-workflow.service';
import eventBus from './event-bus';
import logger from '../utils/logger';
import { UserCreationStatus } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';

const RESEND_COOLDOWN_MS = 60 * 1000; // 60s rate-limit on Resend Invite

export interface RequesterIdentity {
  id: string;
  username: string;
  email: string;
}

export interface ReviewerIdentity {
  id: string;
  username: string;
}

export class UserCreationService {
  /**
   * Called from GET /auth/me on every session load. Idempotent.
   *
   * - If a row already exists for the user, returns it untouched.
   * - Otherwise, looks up RedashUser by email. If the user already exists on Redash
   *   (the "already provisioned out-of-band" edge case), creates the row directly in
   *   COMPLETED with externalUserId populated, so the banner never shows.
   * - If not on Redash, creates a DRAFT row that the user can submit later.
   */
  async ensureDraftForUser(user: RequesterIdentity) {
    const existing = await prisma.userCreationRequest.findUnique({
      where: { userId: user.id },
    });
    if (existing) return existing;

    const lowerEmail = user.email.toLowerCase();
    const redashUser = await prisma.redashUser.findUnique({
      where: { email: lowerEmail },
    });

    if (redashUser && !redashUser.isDisabled) {
      logger.info(
        { userId: user.id, email: lowerEmail, redashUserId: redashUser.id },
        '🌱 Auto-completing user-creation request (user already exists on Redash)',
      );
      return prisma.userCreationRequest.create({
        data: {
          userId: user.id,
          userName: user.username,
          userEmail: lowerEmail,
          status: UserCreationStatus.COMPLETED,
          externalUserId: redashUser.id,
          completedAt: new Date(),
        },
      });
    }

    return prisma.userCreationRequest.create({
      data: {
        userId: user.id,
        userName: user.username,
        userEmail: lowerEmail,
        status: UserCreationStatus.DRAFT,
      },
    });
  }

  /** Move DRAFT -> PENDING with a justification. */
  async submitRequest(userId: string, justification: string) {
    if (!justification || justification.trim().length < 10) {
      throw new ValidationError('Justification must be at least 10 characters long');
    }

    const row = await prisma.userCreationRequest.findUnique({ where: { userId } });
    if (!row) {
      throw new NotFoundError('User-creation request not found. Refresh the page and try again.');
    }
    if (row.status !== UserCreationStatus.DRAFT) {
      throw new ConflictError(`Cannot submit: request is already ${row.status}`);
    }

    const updated = await prisma.userCreationRequest.update({
      where: { id: row.id },
      data: {
        justification: justification.trim(),
        status: UserCreationStatus.PENDING,
        submittedAt: new Date(),
      },
    });

    eventBus.emitAccessEvent({
      type: 'user-creation.submitted',
      payload: {
        requestId: updated.id,
        userId: updated.userId,
        userName: updated.userName,
        userEmail: updated.userEmail,
        justification: updated.justification,
      },
      timestamp: new Date(),
    });

    return updated;
  }

  async getMyRequest(userId: string) {
    return prisma.userCreationRequest.findUnique({ where: { userId } });
  }

  /** Admin: list everything currently in PENDING state. */
  async listPending() {
    return prisma.userCreationRequest.findMany({
      where: { status: UserCreationStatus.PENDING },
      orderBy: { submittedAt: 'asc' },
    });
  }

  /**
   * Admin approves or rejects a user-creation request.
   *
   * APPROVED branch:
   *  - Marks row APPROVED (transient).
   *  - Calls redashService.findOrInviteUser → Redash emails its native setup link.
   *  - On success, row → AWAITING_SETUP with inviteSentAt set.
   *  - On failure, row stays at APPROVED with inviteError populated; admin/user can retry via Resend.
   *
   * REJECTED branch:
   *  - Marks row REJECTED; cascade-rejects the user's pending group requests.
   */
  async reviewRequest(
    requestId: string,
    reviewer: ReviewerIdentity,
    status: 'APPROVED' | 'REJECTED',
    note?: string,
  ) {
    const row = await prisma.userCreationRequest.findUnique({ where: { id: requestId } });
    if (!row) throw new NotFoundError('User-creation request not found');
    if (row.status !== UserCreationStatus.PENDING) {
      throw new ValidationError(`Request is not pending (current status: ${row.status})`);
    }

    if (status === 'REJECTED') {
      const updated = await prisma.userCreationRequest.update({
        where: { id: row.id },
        data: {
          status: UserCreationStatus.REJECTED,
          reviewerId: reviewer.id,
          reviewerName: reviewer.username,
          reviewNote: note,
          reviewedAt: new Date(),
          rejectionReason: note,
        },
      });

      await prisma.auditEntry.create({
        data: {
          action: 'USER_CREATION_REJECTED',
          performerId: reviewer.id,
          performerName: reviewer.username,
          targetUserId: row.userId,
          targetUserName: row.userName,
          details: { note },
        },
      });

      // Cascade-reject any of this user's pending group requests.
      try {
        await accessWorkflowService.cascadeRejectForUser(row.userId, 'User creation rejected');
      } catch (err: any) {
        logger.error(
          { userId: row.userId, error: err.message },
          'Failed to cascade-reject group requests for rejected user',
        );
      }

      eventBus.emitAccessEvent({
        type: 'user-creation.rejected',
        payload: {
          requestId: updated.id,
          userId: updated.userId,
          userName: updated.userName,
          userEmail: updated.userEmail,
          reviewerName: reviewer.username,
          note,
        },
        timestamp: new Date(),
      });

      return updated;
    }

    // APPROVED branch
    await prisma.userCreationRequest.update({
      where: { id: row.id },
      data: {
        status: UserCreationStatus.APPROVED,
        reviewerId: reviewer.id,
        reviewerName: reviewer.username,
        reviewNote: note,
        reviewedAt: new Date(),
        approvedAt: new Date(),
        inviteError: null,
      },
    });

    try {
      const { id: externalUserId, inviteLink } = await redashService.findOrInviteUser(
        row.userEmail,
        row.userName,
      );

      // If the user already exists on Redash (no inviteLink returned), skip AWAITING_SETUP
      // and go straight to COMPLETED — they don't need a setup link.
      const alreadyOnRedash = !inviteLink;

      if (alreadyOnRedash) {
        const completed = await prisma.userCreationRequest.update({
          where: { id: row.id },
          data: {
            status: UserCreationStatus.COMPLETED,
            externalUserId,
            inviteSentAt: new Date(),
            inviteLink: null,
            completedAt: new Date(),
          },
        });

        await prisma.auditEntry.create({
          data: {
            action: 'USER_CREATION_APPROVED',
            performerId: reviewer.id,
            performerName: reviewer.username,
            targetUserId: row.userId,
            targetUserName: row.userName,
            details: { externalUserId, shortCircuited: true },
          },
        });

        eventBus.emitAccessEvent({
          type: 'user-creation.completed',
          payload: {
            requestId: completed.id,
            userId: completed.userId,
            userName: completed.userName,
            userEmail: completed.userEmail,
            externalUserId,
          },
          timestamp: new Date(),
        });

        // Provision any group requests that landed in WAITING_FOR_SETUP earlier
        // (shouldn't exist at this point, but be defensive).
        accessWorkflowService.provisionWaitingRequests(completed.userId).catch((err) => {
          logger.error(
            { userId: completed.userId, error: err.message },
            'provisionWaitingRequests failed after short-circuit completion',
          );
        });

        return completed;
      }

      const awaiting = await prisma.userCreationRequest.update({
        where: { id: row.id },
        data: {
          status: UserCreationStatus.AWAITING_SETUP,
          externalUserId,
          inviteSentAt: new Date(),
          inviteLink,
        },
      });

      await prisma.auditEntry.create({
        data: {
          action: 'USER_CREATION_APPROVED',
          performerId: reviewer.id,
          performerName: reviewer.username,
          targetUserId: row.userId,
          targetUserName: row.userName,
          details: { externalUserId, note },
        },
      });

      eventBus.emitAccessEvent({
        type: 'user-creation.invited',
        payload: {
          requestId: awaiting.id,
          userId: awaiting.userId,
          userName: awaiting.userName,
          userEmail: awaiting.userEmail,
          reviewerName: reviewer.username,
        },
        timestamp: new Date(),
      });

      return awaiting;
    } catch (err: any) {
      logger.error(
        { requestId: row.id, error: err.message },
        'Redash invite failed during user-creation approval; row stays at APPROVED for retry',
      );
      await prisma.userCreationRequest.update({
        where: { id: row.id },
        data: { inviteError: err.message },
      });
      throw err;
    }
  }

  /**
   * Re-trigger the Redash invite (idempotent: findOrInviteUser returns the existing ID if it's already there).
   * Only meaningful in APPROVED (retry after failure) or AWAITING_SETUP (user wants a fresh email).
   */
  async resendInvite(userId: string) {
    const row = await prisma.userCreationRequest.findUnique({ where: { userId } });
    if (!row) throw new NotFoundError('User-creation request not found');

    if (
      row.status !== UserCreationStatus.AWAITING_SETUP &&
      row.status !== UserCreationStatus.APPROVED
    ) {
      throw new ConflictError(`Cannot resend invite: status is ${row.status}`);
    }

    if (row.inviteSentAt && Date.now() - row.inviteSentAt.getTime() < RESEND_COOLDOWN_MS) {
      throw new ConflictError('Please wait a minute before requesting another invite');
    }

    try {
      const { id: externalUserId, inviteLink } = await redashService.findOrInviteUser(
        row.userEmail,
        row.userName,
      );
      const updated = await prisma.userCreationRequest.update({
        where: { id: row.id },
        data: {
          status: UserCreationStatus.AWAITING_SETUP,
          externalUserId,
          inviteSentAt: new Date(),
          inviteError: null,
          // Only overwrite inviteLink when we actually got a fresh one back. Keep
          // the existing one otherwise so the user doesn't lose it on retry.
          ...(inviteLink ? { inviteLink } : {}),
        },
      });
      logger.info({ userId, externalUserId, hadNewLink: !!inviteLink }, '📨 Resent Redash invite');
      return updated;
    } catch (err: any) {
      await prisma.userCreationRequest.update({
        where: { id: row.id },
        data: { inviteError: err.message },
      });
      throw err;
    }
  }

  /**
   * User clicks "I've finished setting up — sync now" after completing the Redash signup.
   * Runs a full Redash sync; if the user now exists, handleRedashUserDetected will fire
   * inside the sync upsert loop and advance the row to COMPLETED.
   */
  async forceSync(userId: string) {
    await syncService.syncWithRedash();
    return this.getMyRequest(userId);
  }

  /**
   * Called from the Redash user-sync upsert loop whenever a RedashUser row is newly inserted
   * (or its isDisabled flipped false). Quietly no-ops if there's nothing to do.
   */
  async handleRedashUserDetected(redashUser: { id: number; email: string; name: string }) {
    const lowerEmail = redashUser.email.toLowerCase();
    const row = await prisma.userCreationRequest.findUnique({
      where: { userEmail: lowerEmail },
    });
    if (!row) return; // No tracked request for this email — nothing to do.

    // Always record externalUserId once we know it, regardless of status.
    if (
      row.status !== UserCreationStatus.AWAITING_SETUP &&
      row.status !== UserCreationStatus.APPROVED
    ) {
      if (row.externalUserId !== redashUser.id) {
        await prisma.userCreationRequest.update({
          where: { id: row.id },
          data: { externalUserId: redashUser.id },
        });
      }
      return;
    }

    // Advance to COMPLETED. Drop the inviteLink — it's a one-time token and is
    // useless past this point.
    const completed = await prisma.userCreationRequest.update({
      where: { id: row.id },
      data: {
        status: UserCreationStatus.COMPLETED,
        externalUserId: redashUser.id,
        completedAt: new Date(),
        inviteLink: null,
      },
    });

    logger.info(
      { userId: completed.userId, externalUserId: redashUser.id },
      '✅ User-creation request completed (Redash user detected)',
    );

    await prisma.auditEntry.create({
      data: {
        action: 'USER_CREATION_COMPLETED',
        performerId: 'system_sync',
        performerName: 'System Sync',
        targetUserId: completed.userId,
        targetUserName: completed.userName,
        details: { externalUserId: redashUser.id },
      },
    });

    eventBus.emitAccessEvent({
      type: 'user-creation.completed',
      payload: {
        requestId: completed.id,
        userId: completed.userId,
        userName: completed.userName,
        userEmail: completed.userEmail,
        externalUserId: redashUser.id,
      },
      timestamp: new Date(),
    });

    // Provision any group requests that were waiting on this user.
    try {
      await accessWorkflowService.provisionWaitingRequests(completed.userId);
    } catch (err: any) {
      logger.error(
        { userId: completed.userId, error: err.message },
        'provisionWaitingRequests threw after user-creation completion',
      );
    }
  }
}

export const userCreationService = new UserCreationService();
export default userCreationService;
