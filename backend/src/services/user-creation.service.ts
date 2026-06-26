import prisma from '../config/prisma';
import config from '../config/config';
import provisioningRegistry from './provisioning.registry';
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
  async ensureDraftForUser(user: RequesterIdentity, platform: string = config.platform.default) {
    const existing = await prisma.userCreationRequest.findUnique({
      where: { userId_platform: { userId: user.id, platform } },
    });
    if (existing) return normalizeInviteLink(existing);

    const lowerEmail = user.email.toLowerCase();

    // userEmail is unique on this table. If a row already exists for this email under
    // a *different* Keycloak userId (same person re-created in Keycloak, or a shared
    // address), adopt it instead of crashing on the unique constraint — the email is
    // the stable identity here and /auth/me only uses this row for display.
    const byEmail = await prisma.userCreationRequest.findUnique({
      where: { userEmail_platform: { userEmail: lowerEmail, platform } },
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

    // If the user already exists on this platform (provisioned out-of-band), read
    // the platform's slice of the generic cache and short-circuit to COMPLETED so
    // the onboarding banner never shows.
    const cachedUser = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform, email: lowerEmail } },
    });

    if (cachedUser && !cachedUser.isDisabled && !cachedUser.isPending) {
      logger.info(
        { userId: user.id, email: lowerEmail, platform, externalId: cachedUser.externalId },
        '🌱 Auto-completing user-creation request (user already exists on platform)',
      );
      return prisma.userCreationRequest.create({
        data: {
          userId: user.id,
          userName: user.username,
          userEmail: lowerEmail,
          platform,
          status: UserCreationStatus.COMPLETED,
          externalUserId: cachedUser.externalId,
          completedAt: new Date(),
        },
      }).then(normalizeInviteLink);
    }

    return prisma.userCreationRequest.create({
      data: {
        userId: user.id,
        userName: user.username,
        userEmail: lowerEmail,
        platform,
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
  async submitRequest(requester: RequesterIdentity, justification: string, platform: string = config.platform.default) {
    if (!justification || justification.trim().length < 10) {
      throw new ValidationError('Justification must be at least 10 characters long');
    }
    // Reject account requests for platforms Hermes can't actually provision: an
    // unregistered platform string would create a PENDING row that can never be
    // approved (the registry lookup throws at approval time), leaving an orphan.
    if (!provisioningRegistry.has(platform)) {
      throw new ValidationError(`Unknown platform "${platform}".`);
    }

    const row = await prisma.userCreationRequest.findUnique({
      where: { userId_platform: { userId: requester.id, platform } },
    });

    // No row yet for this (user, platform). Platforms other than the login-default
    // (Redash) aren't auto-drafted on /auth/me, so the first submit creates the row
    // straight into PENDING with the justification.
    if (!row) {
      const created = await prisma.userCreationRequest.create({
        data: {
          userId: requester.id,
          userName: requester.username,
          userEmail: requester.email.toLowerCase(),
          platform,
          justification: justification.trim(),
          status: UserCreationStatus.PENDING,
          submittedAt: new Date(),
        },
      });
      eventBus.emitAccessEvent({
        type: 'user-creation.submitted',
        payload: {
          requestId: created.id,
          userId: created.userId,
          userName: created.userName,
          userEmail: created.userEmail,
          justification: created.justification,
          platform: created.platform,
        },
        timestamp: new Date(),
      });
      return normalizeInviteLink(created);
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
        platform: updated.platform,
      },
      timestamp: new Date(),
    });

    return normalizeInviteLink(updated);
  }

  async getMyRequest(userId: string, platform: string = config.platform.default) {
    return prisma.userCreationRequest
      .findUnique({ where: { userId_platform: { userId, platform } } })
      .then(row => (row ? normalizeInviteLink(row) : null));
  }

  /** All of a user's account-creation requests across platforms. */
  async getMyRequests(userId: string) {
    const rows = await prisma.userCreationRequest.findMany({ where: { userId } });
    return rows.map(normalizeInviteLink);
  }

  /**
   * Admin: list everything currently in PENDING state, plus APPROVED requests that
   * failed provisioning. Optionally scoped to a set of platforms — a platform admin
   * only reviews account requests for the platform(s) they administer; a super admin
   * passes no filter and sees every platform.
   */
  async listPending(platforms?: string[]) {
    return prisma.userCreationRequest.findMany({
      where: {
        ...(platforms ? { platform: { in: platforms } } : {}),
        OR: [
          { status: UserCreationStatus.PENDING },
          { status: UserCreationStatus.APPROVED, inviteError: { not: null } },
        ],
      },
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
      // Allow re-approving (retrying) a request that failed during the platform invite step
      if (!(row.status === UserCreationStatus.APPROVED && row.inviteError && status === 'APPROVED')) {
        throw new ValidationError(`Request is not pending (current status: ${row.status})`);
      }
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
        await accessWorkflowService.cascadeRejectForUser(row.userId, 'User creation rejected', row.platform);
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

    // APPROVED branch — mark APPROVED, then run the platform invite.
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

    return this._executeInvite(row, reviewer, note);
  }

  /**
   * Run the platform invite for an already-APPROVED row and finalize it: COMPLETED
   * when the account is ready immediately (an existing Redash user, or a freshly
   * created AWS Identity Center user), or AWAITING_SETUP when the adapter returns a
   * one-time setup link the user must visit. On failure the row is left APPROVED with
   * inviteError set and the error is rethrown. Shared by reviewRequest (first
   * approval) and resendInvite (retry of a previously failed invite), so a transient
   * failure on any platform — including AWS — always has a recovery path.
   */
  private async _executeInvite(
    row: { id: string; userId: string; userName: string; userEmail: string; platform: string },
    reviewer: ReviewerIdentity,
    note?: string,
  ) {
    try {
      // Route the account creation through the platform's adapter (Redash invites,
      // AWS Identity Center CreateUser, …). The adapter may return a one-time setup
      // link in metadata; if so the user must finish setup, otherwise the account
      // is ready immediately.
      const adapter = provisioningRegistry.get(row.platform);
      const inviteResult = await adapter.inviteUser(row.userEmail, row.userName, row.userId);
      const externalUserId = inviteResult.externalUserId;
      const inviteLink = (inviteResult.metadata?.inviteLink as string | undefined) ?? null;

      // No setup link → account is ready now (an existing Redash user, or an AWS
      // Identity Center user we just created): complete immediately. A fresh Redash
      // invite returns a link → wait for the user to finish setup (sync completes it).
      const completeNow = !inviteLink;

      if (completeNow) {
        const completed = await prisma.userCreationRequest.update({
          where: { id: row.id },
          data: {
            status: UserCreationStatus.COMPLETED,
            externalUserId,
            inviteSentAt: new Date(),
            inviteLink: null,
            inviteError: null,
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
            details: { externalUserId, platform: row.platform, shortCircuited: true },
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
            platform: completed.platform,
            // Per-completion data for the adapter's onboarding message (e.g. ZooKeeper's
            // one-time digest credential). Not persisted; the bus logs only the event type.
            onboardingDetails: inviteResult.metadata,
          },
          timestamp: new Date(),
        });

        // Release any of this user's group requests for THIS platform that were
        // queued in WAITING_FOR_SETUP.
        accessWorkflowService.provisionWaitingRequests(completed.userId, row.platform).catch((err) => {
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
          inviteError: null,
        },
      });

      await prisma.auditEntry.create({
        data: {
          action: 'USER_CREATION_APPROVED',
          performerId: reviewer.id,
          performerName: reviewer.username,
          targetUserId: row.userId,
          targetUserName: row.userName,
          details: { externalUserId, platform: row.platform, note },
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
          platform: awaiting.platform,
        },
        timestamp: new Date(),
      });

      return normalizeInviteLink(awaiting);
    } catch (err: any) {
      logger.error(
        { requestId: row.id, platform: row.platform, error: err.message },
        'Platform invite failed during user-creation approval; row stays at APPROVED for retry',
      );
      await prisma.userCreationRequest.update({
        where: { id: row.id },
        data: { inviteError: err.message },
      });
      throw err;
    }
  }

  /**
   * Re-trigger the platform invite.
   *
   * - Redash: always re-issues a fresh invite link via POST /api/users/<id>/invite
   *   rather than reusing whatever was stored — old links can be stale (different
   *   host/port) if REDASH_BASE_URL changed. Valid in APPROVED (retry after failure)
   *   or AWAITING_SETUP (user wants a fresh email).
   * - Other platforms (AWS Identity Center): there is no regenerable setup link, but a
   *   FAILED invite (APPROVED + inviteError) is still retried by re-running the
   *   adapter's account creation, so a transient failure isn't a dead end.
   */
  async resendInvite(userId: string, platform: string = config.platform.default) {
    const row = await prisma.userCreationRequest.findUnique({
      where: { userId_platform: { userId, platform } },
    });
    if (!row) throw new NotFoundError('User-creation request not found');

    const adapter = provisioningRegistry.get(row.platform);

    // Platforms whose invite is NOT a regenerable link don't implement
    // regenerateInvite (e.g. AWS Identity Center emails its own SSO sign-in link).
    // There's nothing to re-issue — but a FAILED invite (APPROVED + inviteError) must
    // stay retryable, otherwise a transient failure strands the account with no
    // recovery path, so re-run the adapter's account creation in that case.
    if (!adapter.regenerateInvite) {
      if (row.status === UserCreationStatus.APPROVED && row.inviteError) {
        if (row.inviteSentAt && Date.now() - row.inviteSentAt.getTime() < RESEND_COOLDOWN_MS) {
          throw new ConflictError('Please wait a minute before retrying.');
        }
        return this._executeInvite(
          row,
          { id: row.reviewerId ?? 'system', username: row.reviewerName ?? 'System' },
          row.reviewNote ?? undefined,
        );
      }
      throw new ValidationError(`Resend is not supported for ${row.platform} accounts`);
    }

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
      // Re-issue the one-time setup link through the adapter so the stored token
      // always points at one that still exists in the configured platform instance.
      const result = await adapter.regenerateInvite(row.userEmail, row.userName);
      const freshLink = (result.metadata?.inviteLink as string | undefined) ?? null;

      const updated = await prisma.userCreationRequest.update({
        where: { id: row.id },
        data: {
          status: UserCreationStatus.AWAITING_SETUP,
          externalUserId: result.externalUserId,
          inviteSentAt: new Date(),
          inviteError: null,
          ...(freshLink ? { inviteLink: freshLink } : {}),
        },
      });
      logger.info(
        { userId, platform: row.platform, externalUserId: result.externalUserId, hadNewLink: !!freshLink },
        '📨 Resent platform invite',
      );
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
  async forceSync(userId: string, platform: string = config.platform.default) {
    const row = await prisma.userCreationRequest.findUnique({
      where: { userId_platform: { userId, platform } },
    });
    if (row) {
      await syncService.syncSingleUser(row.userEmail, platform);
    }
    return this.getMyRequest(userId, platform);
  }

  /**
   * Called from a platform adapter's user-sync loop (Redash, AWS, …) whenever a
   * platform user is seen. Advances that platform's account-creation request to
   * COMPLETED once the user exists and is no longer pending. Quietly no-ops if
   * there's no tracked request for this (email, platform). `externalId` is the
   * user's id on the platform as a string.
   */
  async handlePlatformUserDetected(
    platform: string,
    user: { externalId: string; email: string; name?: string; isPending?: boolean },
  ) {
    const lowerEmail = user.email.toLowerCase();
    const row = await prisma.userCreationRequest.findUnique({
      where: { userEmail_platform: { userEmail: lowerEmail, platform } },
    });
    if (!row) return; // No tracked request for this email+platform — nothing to do.

    // If the invite is still pending, they are not finished setting up.
    // Record externalUserId if needed, but do not advance to COMPLETED.
    if (user.isPending) {
      if (row.externalUserId !== user.externalId) {
        await prisma.userCreationRequest.update({
          where: { id: row.id },
          data: { externalUserId: user.externalId },
        });
      }
      return;
    }

    // Always record externalUserId once we know it, regardless of status.
    if (
      row.status !== UserCreationStatus.AWAITING_SETUP &&
      row.status !== UserCreationStatus.APPROVED
    ) {
      if (row.externalUserId !== user.externalId) {
        await prisma.userCreationRequest.update({
          where: { id: row.id },
          data: { externalUserId: user.externalId },
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
        externalUserId: user.externalId,
        completedAt: new Date(),
        inviteLink: null,
      },
    });

    logger.info(
      { userId: completed.userId, platform, externalUserId: user.externalId },
      '✅ User-creation request completed (platform user detected)',
    );

    await prisma.auditEntry.create({
      data: {
        action: 'USER_CREATION_COMPLETED',
        performerId: 'system_sync',
        performerName: 'System Sync',
        targetUserId: completed.userId,
        targetUserName: completed.userName,
        details: { externalUserId: user.externalId, platform },
      },
    });

    eventBus.emitAccessEvent({
      type: 'user-creation.completed',
      payload: {
        requestId: completed.id,
        userId: completed.userId,
        userName: completed.userName,
        userEmail: completed.userEmail,
        externalUserId: user.externalId,
        platform,
      },
      timestamp: new Date(),
    });

    // Provision any group requests for THIS platform that were waiting on this user.
    try {
      await accessWorkflowService.provisionWaitingRequests(completed.userId, platform);
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
