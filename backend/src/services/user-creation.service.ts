import prisma from '../config/prisma';
import redashService from './redash.service';
import syncService from './sync.service';
import accessWorkflowService from './access-workflow.service';
import eventBus from './event-bus';
import logger from '../utils/logger';
import { UserCreationStatus } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { normalizeRedashInviteLink } from '../utils/redash-url';

const RESEND_COOLDOWN_MS = 60 * 1000; // 60s rate-limit on Resend Invite

/**
 * Row-shaped wrapper around `normalizeRedashInviteLink`. Returns the same row
 * with `inviteLink` rewritten to match REDASH_BASE_URL so historical rows
 * with stale links (e.g. wrong port from earlier bugs) come out clean.
 */
function normalizeInviteLink<T extends { inviteLink?: string | null }>(row: T): T {
  if (row.inviteLink) {
    row.inviteLink = normalizeRedashInviteLink(row.inviteLink);
  }
  return row;
}

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
    if (existing) return normalizeInviteLink(existing);

    const lowerEmail = user.email.toLowerCase();

    // userEmail is unique on this table. If a row already exists for this email under
    // a *different* Keycloak userId (same person re-created in Keycloak, or a shared
    // address), adopt it instead of crashing on the unique constraint — the email is
    // the stable identity here and /auth/me only uses this row for display.
    const byEmail = await prisma.userCreationRequest.findUnique({
      where: { userEmail: lowerEmail },
    });
    if (byEmail) {
      // Same email under a different Keycloak userId (user re-created in Keycloak,
      // or a shared address). Re-point the row at the current userId/userName so the
      // user's own status lookups keep working — getMyRequest and submitRequest are
      // both keyed on userId, so leaving the stale userId here would make /me return
      // null and submitRequest throw NotFoundError.
      logger.warn(
        { userId: user.id, previousUserId: byEmail.userId, email: lowerEmail },
        'user-creation request exists for this email under a different userId — re-pointing it at the current user',
      );
      const adopted = await prisma.userCreationRequest.update({
        where: { id: byEmail.id },
        data: { userId: user.id, userName: user.username },
      });
      return normalizeInviteLink(adopted);
    }

    // The user-creation gate is Redash-specific today, so we read the Redash
    // slice of the generic platform cache directly.
    const cachedRedashUser = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: 'redash', email: lowerEmail } },
    });

    if (cachedRedashUser && !cachedRedashUser.isDisabled && !cachedRedashUser.isPending) {
      const redashUserId = parseInt(cachedRedashUser.externalId, 10);
      logger.info(
        { userId: user.id, email: lowerEmail, redashUserId },
        '🌱 Auto-completing user-creation request (user already exists on Redash)',
      );
      return prisma.userCreationRequest.create({
        data: {
          userId: user.id,
          userName: user.username,
          userEmail: lowerEmail,
          status: UserCreationStatus.COMPLETED,
          externalUserId: redashUserId,
          completedAt: new Date(),
        },
      }).then(normalizeInviteLink);
    }

    return prisma.userCreationRequest.create({
      data: {
        userId: user.id,
        userName: user.username,
        userEmail: lowerEmail,
        status: UserCreationStatus.DRAFT,
      },
    }).then(normalizeInviteLink);
  }

  /**
   * Move DRAFT -> PENDING with a justification.
   *
   * Also handles re-requesting after a rejection: a REJECTED request can be
   * submitted again, which gives the user a fresh review cycle. In that case we
   * clear the previous review fields (reviewer, note, rejection reason) so admins
   * see a clean pending request rather than last round's decision.
   */
  async submitRequest(userId: string, justification: string) {
    if (!justification || justification.trim().length < 10) {
      throw new ValidationError('Justification must be at least 10 characters long');
    }

    const row = await prisma.userCreationRequest.findUnique({ where: { userId } });
    if (!row) {
      throw new NotFoundError('User-creation request not found. Refresh the page and try again.');
    }
    const isResubmit = row.status === UserCreationStatus.REJECTED;
    if (row.status !== UserCreationStatus.DRAFT && !isResubmit) {
      throw new ConflictError(`Cannot submit: request is already ${row.status}`);
    }

    const updated = await prisma.userCreationRequest.update({
      where: { id: row.id },
      data: {
        justification: justification.trim(),
        status: UserCreationStatus.PENDING,
        submittedAt: new Date(),
        // Re-requesting after a rejection: wipe the prior decision so the row
        // reads as a clean pending request again.
        ...(isResubmit
          ? {
              reviewerId: null,
              reviewerName: null,
              reviewNote: null,
              reviewedAt: null,
              rejectionReason: null,
            }
          : {}),
      },
    });

    if (isResubmit) {
      await prisma.auditEntry.create({
        data: {
          action: 'USER_CREATION_RESUBMITTED',
          performerId: updated.userId,
          performerName: updated.userName,
          targetUserId: updated.userId,
          targetUserName: updated.userName,
          details: { justification: updated.justification },
        },
      });
    }

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

    return normalizeInviteLink(updated);
  }

  async getMyRequest(userId: string) {
    return prisma.userCreationRequest.findUnique({ where: { userId } }).then(row => row ? normalizeInviteLink(row) : null);
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

      return normalizeInviteLink(updated);
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

        return normalizeInviteLink(completed);
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

      return normalizeInviteLink(awaiting);
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
   * Re-trigger the Redash invite. Always re-issues a fresh invite link via
   * POST /api/users/<id>/invite rather than reusing whatever was stored — old
   * links can be stale (different host/port) if REDASH_BASE_URL changed.
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
      // First make sure we know the Redash user ID.
      const { id: externalUserId } = await redashService.findOrInviteUser(
        row.userEmail,
        row.userName,
      );

      // Then explicitly regenerate the invite link so the row always points at
      // a token that still exists in the configured Redash instance.
      const freshLink = await redashService.regenerateInviteLink(externalUserId);

      const updated = await prisma.userCreationRequest.update({
        where: { id: row.id },
        data: {
          status: UserCreationStatus.AWAITING_SETUP,
          externalUserId,
          inviteSentAt: new Date(),
          inviteError: null,
          ...(freshLink ? { inviteLink: freshLink } : {}),
        },
      });
      logger.info({ userId, externalUserId, hadNewLink: !!freshLink }, '📨 Resent Redash invite');
      return normalizeInviteLink(updated);
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
    const row = await prisma.userCreationRequest.findUnique({ where: { userId } });
    if (row) {
      await syncService.syncSingleUser(row.userEmail);
    }
    return this.getMyRequest(userId);
  }

  /**
   * Called from the Redash user-sync upsert loop whenever a RedashUser row is newly inserted
   * (or its isDisabled flipped false). Quietly no-ops if there's nothing to do.
   */
  async handleRedashUserDetected(redashUser: { id: number; email: string; name: string; isInvitationPending?: boolean }) {
    const lowerEmail = redashUser.email.toLowerCase();
    const row = await prisma.userCreationRequest.findUnique({
      where: { userEmail: lowerEmail },
    });
    if (!row) return; // No tracked request for this email — nothing to do.

    // If the invite is still pending, they are not finished setting up.
    // Record externalUserId if needed, but do not advance to COMPLETED.
    if (redashUser.isInvitationPending) {
      if (row.externalUserId !== redashUser.id) {
        await prisma.userCreationRequest.update({
          where: { id: row.id },
          data: { externalUserId: redashUser.id },
        });
      }
      return;
    }

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
