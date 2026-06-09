import prisma from '../config/prisma';
import provisioningRegistry from './provisioning.registry';
import { PlatformAdapter } from './provisioner.interface';
import eventBus from './event-bus';
import logger from '../utils/logger';
import { AccessDuration, AccessRequest, RequestStatus, UserCreationStatus, Prisma } from '@prisma/client';
import { ValidationError, NotFoundError, ConflictError, UserNotApprovedError } from '../utils/errors';

type GroupRow = { id: string; name: string; slug: string; platform: string; externalGroupId: string | null };
type LevelRow = { id: string; name: string; slug: string; externalGroupId: string | null };
type AccessRequestWithGroup = AccessRequest & { group: GroupRow; level?: LevelRow | null };

// After this many consecutive failed auto-expiry attempts, the scheduler stops
// retrying every cron run: it force-marks the grant inactive in Hermes, audits it,
// and alerts admins (the user may still exist on the platform — flagged for manual
// cleanup) rather than throwing forever and re-processing the same grant each run.
const MAX_EXPIRY_ATTEMPTS = 3;

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
    duration: AccessDuration,
    levelId?: string | null
  ) {
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundError('Group not found');

    // Resolve the requested level. If the group has any active levels, one must be
    // chosen; if it has none, a level must NOT be supplied. The single `find` check
    // enforces both "belongs to this group" and "is active".
    const activeLevels = await prisma.groupLevel.findMany({
      where: { groupId, isActive: true },
    });
    let level: LevelRow | null = null;
    if (activeLevels.length > 0) {
      if (!levelId) throw new ValidationError('This group requires selecting a level.');
      level = activeLevels.find((l) => l.id === levelId) ?? null;
      if (!level) throw new ValidationError('Invalid or inactive level for this group.');
      // A level must be backed by its own external group. Block the request early
      // rather than silently falling back to the base group at provision time.
      if (!level.externalGroupId) {
        throw new ValidationError('This level is not fully configured yet (no backing platform group). Please contact an admin.');
      }
    } else if (levelId) {
      throw new ValidationError('This group has no levels; do not specify a level.');
    }

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

    // Check if there is a pending request (including WAITING_FOR_SETUP — already approved, just unprovisioned)
    const pendingRequest = await prisma.accessRequest.findFirst({
      where: {
        requesterId: requester.id,
        groupId: groupId,
        status: { in: [RequestStatus.PENDING, RequestStatus.WAITING_FOR_SETUP] },
      },
    });
    if (pendingRequest) {
      throw new ConflictError('You already have a pending request for this group.');
    }

    return this._persistPendingRequest(requester, group, level, justification, duration);
  }

  /**
   * Persist a PENDING access request + its REQUEST_CREATED audit row, and notify
   * admins. Shared by the first-time request flow (createRequest) and the gated
   * (promotion) branch of a level change (changeLevel). Both produce an identical
   * "awaiting admin review" request — the only difference upstream is the guard
   * logic that decides whether a request is allowed.
   */
  private async _persistPendingRequest(
    requester: { id: string; username: string; email: string },
    group: { id: string; name: string },
    level: LevelRow | null,
    justification: string,
    duration: AccessDuration,
  ): Promise<AccessRequest> {
    const expiresAt = this.calculateExpiry(duration);

    const request = await prisma.accessRequest.create({
      data: {
        groupId: group.id,
        levelId: level?.id ?? null,
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
        groupId: group.id,
        accessRequestId: request.id,
        details: { duration, expiresAt, levelId: level?.id ?? null, levelName: level?.name ?? null },
      },
    });

    // Notify admins via Event Bus
    eventBus.emitAccessEvent({
      type: 'request.created',
      payload: {
        requestId: request.id,
        groupId: group.id,
        groupName: level ? `${group.name} — ${level.name}` : group.name,
        requesterName: requester.username,
        justification,
        duration,
      },
      timestamp: new Date(),
    });

    return request;
  }

  /**
   * Persist a self-reviewed (instant) access request in PROVISIONING + its
   * REQUEST_CREATED audit row, returned with group+level included (ready for
   * _provision, no re-fetch). Shared by the self-service demotion branch of
   * changeLevel and by adminSetMemberLevel — both create an immediately-provisioned
   * request whose reviewer is the performer; only the copy/audit details differ.
   */
  private async _persistSelfReviewedRequest(opts: {
    performer: { id: string; username: string };
    target: { id: string; name: string; email: string };
    groupId: string;
    level: { id: string; name: string };
    justification: string;
    duration: AccessDuration;
    reviewNote: string;
    auditDetails: Record<string, unknown>;
  }): Promise<AccessRequestWithGroup> {
    const expiresAt = this.calculateExpiry(opts.duration);
    const created = await prisma.accessRequest.create({
      data: {
        groupId: opts.groupId,
        levelId: opts.level.id,
        requesterId: opts.target.id,
        requesterName: opts.target.name,
        requesterEmail: opts.target.email,
        justification: opts.justification,
        duration: opts.duration,
        expiresAt,
        status: RequestStatus.PROVISIONING,
        reviewerId: opts.performer.id,
        reviewerName: opts.performer.username,
        reviewNote: opts.reviewNote,
        reviewedAt: new Date(),
      },
      include: { group: true, level: true },
    });

    await prisma.auditEntry.create({
      data: {
        action: 'REQUEST_CREATED',
        performerId: opts.performer.id,
        performerName: opts.performer.username,
        targetUserId: opts.target.id,
        targetUserName: opts.target.name,
        groupId: opts.groupId,
        accessRequestId: created.id,
        details: {
          duration: opts.duration,
          expiresAt,
          levelId: opts.level.id,
          levelName: opts.level.name,
          ...opts.auditDetails,
        },
      },
    });

    return created;
  }

  /**
   * Change the level a user already holds in a group (promote or demote). The user
   * keeps exactly one active grant per group — this resolves to a swap, never an
   * extra grant.
   *
   * Direction is decided server-side by level `rank` (higher = more senior):
   *   - demotion  (target rank < current rank): self-service — provisioned
   *     immediately. Lowering your own access carries no escalation risk.
   *   - promotion / lateral (target rank ≥ current, or coming from a level-less
   *     grant): goes through the normal request → admin approval flow. The current
   *     level stays active until an admin approves; the swap happens at provision.
   *
   * Returns `kind: 'instant'` with the provisioned request, or `kind: 'request'`
   * with the new PENDING request, so the caller can tell the user what happened.
   */
  async changeLevel(
    requester: { id: string; username: string; email: string },
    groupId: string,
    levelId: string,
    justification: string,
    duration: AccessDuration,
  ): Promise<{ kind: 'instant' | 'request'; request: AccessRequest }> {
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundError('Group not found');

    const activeLevels = await prisma.groupLevel.findMany({
      where: { groupId, isActive: true },
    });
    if (activeLevels.length === 0) {
      throw new ValidationError('This group has no levels to switch between.');
    }

    const targetLevel = activeLevels.find((l) => l.id === levelId) ?? null;
    if (!targetLevel) throw new ValidationError('Invalid or inactive level for this group.');
    // A level must be backed by its own external group, same rule as createRequest.
    if (!targetLevel.externalGroupId) {
      throw new ValidationError('This level is not fully configured yet (no backing platform group). Please contact an admin.');
    }

    // The user must already hold active access to this group — otherwise there is
    // nothing to change; they should request access the normal way first.
    const currentAccess = await prisma.userAccess.findFirst({
      where: { userId: requester.id, groupId, isActive: true },
      include: { level: true },
    });
    if (!currentAccess) {
      throw new ConflictError('You do not have active access to this group, so there is no level to change. Request access first.');
    }
    if (currentAccess.levelId === targetLevel.id) {
      throw new ConflictError('You already hold this level for this group.');
    }

    // One open request per group — block if a previous request is still in flight.
    const pendingRequest = await prisma.accessRequest.findFirst({
      where: {
        requesterId: requester.id,
        groupId,
        status: { in: [RequestStatus.PENDING, RequestStatus.WAITING_FOR_SETUP] },
      },
    });
    if (pendingRequest) {
      throw new ConflictError('You already have a pending request for this group. Wait for it to be reviewed before changing your level.');
    }

    // A move to a strictly lower rank is a demotion (instant). A level-less current
    // grant has no rank to compare against, so it is treated as a promotion (gated).
    const currentRank = currentAccess.level?.rank ?? Number.NEGATIVE_INFINITY;
    const isDemotion = currentAccess.levelId != null && targetLevel.rank < currentRank;

    if (!isDemotion) {
      // Promotion / lateral move → gated request, current level kept until approved.
      const request = await this._persistPendingRequest(requester, group, targetLevel, justification, duration);
      return { kind: 'request', request };
    }

    // Demotion → provision immediately. Carry the CURRENT grant's duration over
    // rather than honouring the client-supplied value: a demotion is self-service
    // precisely because lowering your level carries no escalation risk, but letting
    // the user also reset their own expiry (e.g. a 1-day grant → PERMANENT) with no
    // review would be a duration escalation. Mirrors adminSetMemberLevel.
    let demotionDuration: AccessDuration = AccessDuration.PERMANENT;
    if (currentAccess.accessRequestId) {
      const orig = await prisma.accessRequest.findUnique({
        where: { id: currentAccess.accessRequestId },
        select: { duration: true },
      });
      if (orig) demotionDuration = orig.duration;
    }

    const fullRequest = await this._persistSelfReviewedRequest({
      performer: { id: requester.id, username: requester.username },
      target: { id: requester.id, name: requester.username, email: requester.email },
      groupId,
      level: targetLevel,
      justification,
      duration: demotionDuration,
      reviewNote: 'Self-service demotion (applied immediately)',
      auditDetails: {
        selfDemotion: true,
        fromLevelId: currentAccess.levelId,
        fromLevelName: currentAccess.level?.name ?? null,
      },
    });
    const provisioned = await this._provision(fullRequest, { id: requester.id, name: requester.username });
    return { kind: 'instant', request: provisioned };
  }

  /**
   * Admin override: set the level a member holds in a group directly — no
   * promote/demote gating, the admin has authority. Applies immediately via the
   * same swap machinery (one active grant per group is preserved). The grant's
   * duration is carried over from the member's originating request, so a time-bound
   * grant stays time-bound and a permanent grant stays permanent (the expiry window
   * is re-applied from now).
   */
  async adminSetMemberLevel(
    performer: { id: string; username: string },
    userAccessId: string,
    levelId: string,
  ): Promise<AccessRequest> {
    const access = await prisma.userAccess.findUnique({
      where: { id: userAccessId },
      include: { group: true, level: true },
    });
    if (!access) throw new NotFoundError('Member access grant not found');
    if (!access.isActive) throw new ValidationError('This grant is no longer active.');

    const activeLevels = await prisma.groupLevel.findMany({
      where: { groupId: access.groupId, isActive: true },
    });
    if (activeLevels.length === 0) {
      throw new ValidationError('This group has no levels to assign.');
    }
    const targetLevel = activeLevels.find((l) => l.id === levelId) ?? null;
    if (!targetLevel) throw new ValidationError('Invalid or inactive level for this group.');
    if (!targetLevel.externalGroupId) {
      throw new ValidationError('This level is not fully configured yet (no backing platform group). Configure it first.');
    }
    if (access.levelId === targetLevel.id) {
      throw new ConflictError('This member already holds that level.');
    }

    // Carry the duration over from the originating request so the expiry policy is
    // preserved (default PERMANENT for legacy/seeded grants with no request).
    let duration: AccessDuration = AccessDuration.PERMANENT;
    if (access.accessRequestId) {
      const orig = await prisma.accessRequest.findUnique({
        where: { id: access.accessRequestId },
        select: { duration: true },
      });
      if (orig) duration = orig.duration;
    }

    const fullRequest = await this._persistSelfReviewedRequest({
      performer: { id: performer.id, username: performer.username },
      target: { id: access.userId, name: access.userName, email: access.userEmail },
      groupId: access.groupId,
      level: targetLevel,
      justification: `Level set to "${targetLevel.name}" by ${performer.username} via Admin Management`,
      duration,
      reviewNote: 'Level set by admin',
      auditDetails: {
        adminSetLevel: true,
        fromLevelId: access.levelId,
        fromLevelName: access.level?.name ?? null,
      },
    });
    return this._provision(fullRequest, { id: performer.id, name: performer.username });
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
      include: { group: true, level: true },
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
          requesterEmail: request.requesterEmail,
          groupName: request.group.name,
          reviewerName: reviewer.username,
          note,
        },
        timestamp: new Date(),
      });

      return updatedRequest;
    }

    // Status: APPROVED → gate on user-creation status FOR THIS GROUP'S PLATFORM,
    // then either provision or queue. The gate is per-platform: a user approved on
    // Redash is NOT thereby approved on AWS — each platform has its own account, so
    // we look up the account-creation request keyed on (user, this group's platform).
    const platform = this.requirePlatform(request.group);
    const userCreation = await prisma.userCreationRequest.findUnique({
      where: { userId_platform: { userId: request.requesterId, platform } },
    });

    // No user-creation row for this platform, or it isn't past the admin-approval bar → block.
    const isApprovedOrLater =
      userCreation &&
      (userCreation.status === UserCreationStatus.APPROVED ||
        userCreation.status === UserCreationStatus.AWAITING_SETUP ||
        userCreation.status === UserCreationStatus.COMPLETED);

    if (!isApprovedOrLater) {
      throw new UserNotApprovedError(
        `Cannot approve this request — the requester is not yet an approved Hermes user on ${platform}. Approve their ${platform} account request first.`,
        { userCreationStatus: userCreation?.status ?? 'MISSING', platform },
      );
    }

    // User-creation approved but the platform account isn't finalized yet → queue for setup completion.
    if (userCreation.status !== UserCreationStatus.COMPLETED) {
      const queued = await prisma.accessRequest.update({
        where: { id: requestId },
        data: {
          status: RequestStatus.WAITING_FOR_SETUP,
          reviewerId: reviewer.id,
          reviewerName: reviewer.username,
          reviewNote: note,
          reviewedAt: new Date(),
        },
      });

      await prisma.auditEntry.create({
        data: {
          action: 'ACCESS_QUEUED_FOR_SETUP',
          performerId: reviewer.id,
          performerName: reviewer.username,
          targetUserId: request.requesterId,
          targetUserName: request.requesterName,
          groupId: request.groupId,
          accessRequestId: requestId,
          details: { userCreationStatus: userCreation.status },
        },
      });

      eventBus.emitAccessEvent({
        type: 'access.queued-for-setup',
        payload: {
          requesterId: request.requesterId,
          groupName: request.group.name,
          reviewerName: reviewer.username,
          platform,
        },
        timestamp: new Date(),
      });

      return queued;
    }

    // User-creation is COMPLETED → original flow: mark review + provision inline.
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

    return this._provision(request, { id: reviewer.id, name: reviewer.username }, note);
  }

  /**
   * Shared provisioning routine — used by reviewRequest (admin path) and
   * provisionWaitingRequests (post-setup path). Assumes the AccessRequest has
   * already been moved to PROVISIONING by the caller; on success transitions to
   * PROVISIONED, on failure to PROVISION_FAILED.
   */
  /**
   * Resolve the platform key for a group, or throw if it isn't configured.
   * Platform routing is explicit — there is no implicit default, because
   * guessing would silently provision against the wrong system.
   */
  private requirePlatform(group: { platform: string | null; name: string }): string {
    if (!group.platform) {
      throw new ValidationError(`Group "${group.name}" has no platform configured`);
    }
    return group.platform.toLowerCase();
  }

  private async _provision(
    request: AccessRequestWithGroup,
    performer: { id: string; name: string },
    note?: string,
  ) {
    logger.info(`Starting provisioning for request ${request.id}...`);

    try {
      // Platform routing happens here: the registry hands back the adapter
      // registered under this group's platform key (Redash today, AWS next).
      const platform = this.requirePlatform(request.group);
      const provisioner = provisioningRegistry.get(platform);

      // A level (if any) owns its own external group. We deliberately do NOT fall
      // back to the group's base externalGroupId for a leveled request — that would
      // silently provision the user into the base group (potentially broader
      // permissions) instead of the level's restricted group. Fail loudly instead.
      const externalGroupId = request.level
        ? request.level.externalGroupId
        : request.group.externalGroupId;
      if (!externalGroupId) {
        throw new Error(
          request.level
            ? `Level "${request.level.name}" has no External Group ID configured — refusing to fall back to the base group. Configure the level's backing platform group first.`
            : `Group ${request.group.name} has no associated External Group ID configured`,
        );
      }

      const result = await provisioner.provision({
        email: request.requesterEmail,
        name: request.requesterName,
        externalGroupId,
        metadata: { groupSlug: request.group.slug, levelSlug: request.level?.slug ?? null },
      });
      const externalUserId = result.externalUserId;

      // Recompute expiry at provision time using the request's duration. Using the
      // value stored on AccessRequest (computed at request-create time) means a
      // 1-day request approved 3 days later would expire immediately.
      const grantedAt = new Date();
      const expiresAt = this.calculateExpiry(request.duration);

      // A pre-existing active grant on a DIFFERENT level means this is a level
      // change → swap it (atomically deactivate the old grant + create the new one,
      // then remove the user from the old level's external group) and finalize.
      // A grant on the SAME level is a genuine duplicate (e.g. concurrent approval)
      // and is left to the P2002 short-circuit in the create branch below.
      const existingGrant = await prisma.userAccess.findFirst({
        where: { userId: request.requesterId, groupId: request.groupId, isActive: true },
        include: { level: true },
      });
      if (existingGrant && existingGrant.levelId !== request.levelId) {
        // _swapGrant now performs the full atomic finalize (deactivate old + create
        // new + revoke old request + mark this request PROVISIONED + audit) inside
        // one transaction and returns the finalized request, so the swap path does
        // NOT call _finalizeProvisioned separately.
        return this._swapGrant(request, existingGrant, {
          externalUserId,
          grantedAt,
          expiresAt,
          performer,
          platform,
          newExternalGroupId: externalGroupId,
          provisioner,
          note,
        });
      }

      let userAccess;
      try {
        userAccess = await prisma.userAccess.create({
          data: {
            userId: request.requesterId,
            userName: request.requesterName,
            userEmail: request.requesterEmail,
            groupId: request.groupId,
            levelId: request.levelId ?? null,
            externalUserId: externalUserId,
            isActive: true,
            grantedAt,
            expiresAt,
            grantedBy: performer.name,
            accessRequestId: request.id,
          },
        });
      } catch (createErr: any) {
        // Partial unique index (user_id, group_id) WHERE is_active = true fired.
        // Someone else just granted the same access — treat as already provisioned,
        // not a hard failure, and point back to the existing grant.
        if (createErr?.code === 'P2002') {
          const existing = await prisma.userAccess.findFirst({
            where: { userId: request.requesterId, groupId: request.groupId, isActive: true },
          });
          if (existing) {
            logger.info(
              { requestId: request.id, userAccessId: existing.id },
              'Active grant already exists for this user+group — short-circuiting to PROVISIONED',
            );
            const concurrentRequest = await prisma.accessRequest.update({
              where: { id: request.id },
              data: {
                status: RequestStatus.PROVISIONED,
                provisionedAt: new Date(),
                provisionError: 'Already provisioned by another admin',
              },
            });
            await prisma.auditEntry.create({
              data: {
                action: 'ACCESS_GRANTED',
                performerId: performer.id,
                performerName: performer.name,
                targetUserId: request.requesterId,
                targetUserName: request.requesterName,
                groupId: request.groupId,
                accessRequestId: request.id,
                details: {
                  userAccessId: existing.id,
                  platform,
                  externalUserId,
                  externalGroupId,
                  levelId: request.levelId ?? null,
                  levelName: request.level?.name ?? null,
                  expiresAt: existing.expiresAt,
                  note: 'Concurrent approval — reused existing UserAccess row',
                },
              },
            });
            return concurrentRequest;
          }
        }
        throw createErr;
      }

      return this._finalizeProvisioned(request, userAccess, {
        performer,
        platform,
        externalUserId,
        externalGroupId,
        expiresAt,
        note,
      });
    } catch (err: any) {
      logger.error(`Provisioning failed for request ${request.id}:`, err.message);

      await prisma.accessRequest.update({
        where: { id: request.id },
        data: {
          status: RequestStatus.PROVISION_FAILED,
          provisionError: err.message,
        },
      });

      await prisma.auditEntry.create({
        data: {
          action: 'PROVISION_FAILED',
          performerId: performer.id,
          performerName: performer.name,
          targetUserId: request.requesterId,
          targetUserName: request.requesterName,
          groupId: request.groupId,
          accessRequestId: request.id,
          details: { error: err.message },
        },
      });

      throw err;
    }
  }

  /**
   * Swap a user from one level grant to another within the same group, preserving
   * the one-active-grant-per-(user,group) invariant. The caller has already
   * provisioned the user into the NEW level's external group; here we atomically
   * deactivate the old grant + create the new one, then remove the user from the
   * OLD level's external group.
   *
   * The platform deprovision is best-effort: the Hermes-side swap has already
   * committed, so a failure is logged + audited for manual cleanup (the user may
   * briefly remain in the old group on the platform) rather than rolled back.
   */
  private async _swapGrant(
    request: AccessRequestWithGroup,
    existingGrant: Prisma.UserAccessGetPayload<{ include: { level: true } }>,
    ctx: {
      externalUserId: string;
      grantedAt: Date;
      expiresAt: Date | null;
      performer: { id: string; name: string };
      platform: string;
      newExternalGroupId: string;
      provisioner: PlatformAdapter;
      note?: string;
    },
  ): Promise<AccessRequest> {
    const { externalUserId, grantedAt, expiresAt, performer, platform, newExternalGroupId, provisioner, note } = ctx;
    const oldExternalGroupId = existingGrant.level?.externalGroupId ?? request.group.externalGroupId;

    // All Hermes-side state changes commit together (no partial-failure window):
    // deactivate the old grant, create the new one, REVOKE the old request, mark THIS
    // request PROVISIONED, and write the ACCESS_GRANTED audit. The deactivate is
    // guarded with `isActive: true` + a row-count check, so a concurrent revoke that
    // slipped in between _provision's read and here aborts the swap (transaction
    // rolls back) instead of silently re-granting access the admin just removed.
    const { finalRequest, newAccess } = await prisma.$transaction(async (tx) => {
      const deactivated = await tx.userAccess.updateMany({
        where: { id: existingGrant.id, isActive: true },
        data: { isActive: false, revokedAt: new Date() },
      });
      if (deactivated.count === 0) {
        throw new ConflictError('This access was changed by someone else — please retry the level change.');
      }

      const newAccess = await tx.userAccess.create({
        data: {
          userId: request.requesterId,
          userName: request.requesterName,
          userEmail: request.requesterEmail,
          groupId: request.groupId,
          levelId: request.levelId ?? null,
          externalUserId,
          isActive: true,
          grantedAt,
          expiresAt,
          grantedBy: performer.name,
          accessRequestId: request.id,
        },
      });

      // Mark the superseded request (the one that granted the old level) REVOKED so
      // request history reflects the swap.
      if (existingGrant.accessRequestId) {
        await tx.accessRequest.update({
          where: { id: existingGrant.accessRequestId },
          data: {
            status: RequestStatus.REVOKED,
            revokeReason: `Superseded by level change to "${request.level?.name ?? 'another level'}"`,
            revokedAt: new Date(),
          },
        });
      }

      const finalRequest = await tx.accessRequest.update({
        where: { id: request.id },
        data: {
          status: RequestStatus.PROVISIONED,
          provisionedAt: new Date(),
          // Sync the request's expiry to the actual grant so the UI shows the truth.
          expiresAt,
        },
      });

      await tx.auditEntry.create({
        data: {
          action: 'ACCESS_GRANTED',
          performerId: performer.id,
          performerName: performer.name,
          targetUserId: request.requesterId,
          targetUserName: request.requesterName,
          groupId: request.groupId,
          accessRequestId: request.id,
          details: {
            userAccessId: newAccess.id,
            platform,
            externalUserId,
            externalGroupId: newExternalGroupId,
            levelId: request.levelId ?? null,
            levelName: request.level?.name ?? null,
            expiresAt,
          },
        },
      });

      return { finalRequest, newAccess };
    });

    // Post-commit, best-effort (never rolls back the committed swap): remove the user
    // from the OLD level's external group on the platform. Skip if both levels
    // resolve to the same external group (that would undo the provision we just did).
    let oldDeprovisionError: string | null = null;
    if (existingGrant.externalUserId && oldExternalGroupId && oldExternalGroupId !== newExternalGroupId) {
      try {
        await provisioner.deprovision({
          externalUserId: existingGrant.externalUserId,
          externalGroupId: oldExternalGroupId,
        });
      } catch (err: any) {
        oldDeprovisionError = err.message;
        logger.error(
          { userAccessId: existingGrant.id, platform, oldExternalGroupId, error: err.message },
          'Level change: failed to remove the user from the previous level group — flagged for manual cleanup',
        );
      }
    }

    // Level-changed audit (records the deprovision outcome) + approval event. Both are
    // non-critical: the swap is already committed, so a failure here only loses the
    // audit/notification — log it rather than surfacing a fake error to the caller.
    try {
      await prisma.auditEntry.create({
        data: {
          action: 'ACCESS_LEVEL_CHANGED',
          performerId: performer.id,
          performerName: performer.name,
          targetUserId: request.requesterId,
          targetUserName: request.requesterName,
          groupId: request.groupId,
          accessRequestId: request.id,
          details: {
            fromLevelId: existingGrant.levelId,
            fromLevelName: existingGrant.level?.name ?? null,
            toLevelId: request.levelId ?? null,
            toLevelName: request.level?.name ?? null,
            oldUserAccessId: existingGrant.id,
            newUserAccessId: newAccess.id,
            platform,
            oldExternalGroupId,
            newExternalGroupId,
            oldDeprovisionError,
          },
        },
      });

      eventBus.emitAccessEvent({
        type: 'request.approved',
        payload: {
          requesterId: request.requesterId,
          requesterEmail: request.requesterEmail,
          groupName: request.group.name,
          reviewerName: request.reviewerName ?? performer.name,
          note: note ?? request.reviewNote ?? undefined,
        },
        timestamp: new Date(),
      });
    } catch (err: any) {
      logger.error(
        { requestId: request.id, error: err.message },
        'Level change: post-commit audit/notify failed (swap already committed)',
      );
    }

    return finalRequest;
  }

  /**
   * Shared tail of a successful provision: flip the request to PROVISIONED, write
   * the ACCESS_GRANTED audit row, and emit request.approved. Used by both the
   * first-grant path and the level-swap path of _provision.
   */
  private async _finalizeProvisioned(
    request: AccessRequestWithGroup,
    userAccess: { id: string },
    ctx: {
      performer: { id: string; name: string };
      platform: string;
      externalUserId: string;
      externalGroupId: string;
      expiresAt: Date | null;
      note?: string;
    },
  ): Promise<AccessRequest> {
    const { performer, platform, externalUserId, externalGroupId, expiresAt, note } = ctx;

    const finalRequest = await prisma.accessRequest.update({
      where: { id: request.id },
      data: {
        status: RequestStatus.PROVISIONED,
        provisionedAt: new Date(),
        // Sync the request's expiry to the actual grant so the UI shows the truth.
        expiresAt,
      },
    });

    await prisma.auditEntry.create({
      data: {
        action: 'ACCESS_GRANTED',
        performerId: performer.id,
        performerName: performer.name,
        targetUserId: request.requesterId,
        targetUserName: request.requesterName,
        groupId: request.groupId,
        accessRequestId: request.id,
        details: {
          userAccessId: userAccess.id,
          platform,
          externalUserId,
          externalGroupId,
          levelId: request.levelId ?? null,
          levelName: request.level?.name ?? null,
          expiresAt,
        },
      },
    });

    eventBus.emitAccessEvent({
      type: 'request.approved',
      payload: {
        requesterId: request.requesterId,
        requesterEmail: request.requesterEmail,
        groupName: request.group.name,
        // The persisted reviewer wins so the post-setup path shows the real
        // approving admin, not "System (post-setup)". note falls back to the
        // note stored at review time (post-setup path has no inline note).
        reviewerName: request.reviewerName ?? performer.name,
        note: note ?? request.reviewNote ?? undefined,
      },
      timestamp: new Date(),
    });

    return finalRequest;
  }

  /**
   * Bulk-reject a user's PENDING + WAITING_FOR_SETUP group requests in one transaction.
   * Called from user-creation service when an admin rejects a user-creation request.
   * Scoped to `platform` when provided (so rejecting one platform's account request
   * does not also reject the user's requests on other platforms); all platforms if
   * omitted. Mirrors the per-platform filter on provisionWaitingRequests.
   */
  async cascadeRejectForUser(userId: string, note: string, platform?: string): Promise<number> {
    const toReject = await prisma.accessRequest.findMany({
      where: {
        requesterId: userId,
        status: { in: [RequestStatus.PENDING, RequestStatus.WAITING_FOR_SETUP] },
        ...(platform ? { group: { platform } } : {}),
      },
      include: { group: true },
    });
    if (toReject.length === 0) return 0;

    const now = new Date();
    await prisma.$transaction([
      prisma.accessRequest.updateMany({
        where: { id: { in: toReject.map((r) => r.id) } },
        data: {
          status: RequestStatus.REJECTED,
          reviewNote: note,
          reviewedAt: now,
        },
      }),
      prisma.auditEntry.createMany({
        data: toReject.map((r) => ({
          action: 'REQUEST_REJECTED',
          performerId: 'system_cascade',
          performerName: 'System (cascade reject)',
          targetUserId: r.requesterId,
          targetUserName: r.requesterName,
          groupId: r.groupId,
          accessRequestId: r.id,
          details: { note, cascade: true },
        })),
      }),
    ]);

    // Emit one rejection event per row so the notification fan-out runs as usual.
    for (const r of toReject) {
      eventBus.emitAccessEvent({
        type: 'request.rejected',
        payload: {
          requesterId: r.requesterId,
          requesterEmail: r.requesterEmail,
          groupName: r.group.name,
          reviewerName: 'System',
          note,
        },
        timestamp: new Date(),
      });
    }

    logger.info(
      { userId, count: toReject.length },
      'Cascade-rejected pending group requests for rejected user',
    );
    return toReject.length;
  }

  /**
   * After a user-creation completes (Redash sync detected the user), provision any
   * of that user's group requests that were queued in WAITING_FOR_SETUP.
   * Per-row try/catch so one provisioning failure doesn't abort the batch.
   */
  async provisionWaitingRequests(
    userId: string,
    platform?: string,
  ): Promise<{ provisioned: number; failed: number }> {
    // When a platform's account completes, only release that platform's queued
    // requests — a user's AWS requests must keep waiting until their AWS account
    // is ready, even after their Redash account completes (and vice versa).
    const waiting = await prisma.accessRequest.findMany({
      where: {
        requesterId: userId,
        status: RequestStatus.WAITING_FOR_SETUP,
        ...(platform ? { group: { platform } } : {}),
      },
      include: { group: true, level: true },
    });
    if (waiting.length === 0) return { provisioned: 0, failed: 0 };

    let provisioned = 0;
    let failed = 0;

    for (const req of waiting) {
      await prisma.accessRequest.update({
        where: { id: req.id },
        data: { status: RequestStatus.PROVISIONING },
      });

      try {
        await this._provision(req, { id: 'system_sync', name: 'System (post-setup)' });
        provisioned += 1;
      } catch (err: any) {
        failed += 1;
        logger.error(
          { requestId: req.id, userId, error: err.message },
          'Failed to provision waiting request after user setup',
        );
        // _provision already wrote PROVISION_FAILED + audit; keep going.
      }
    }

    logger.info(
      { userId, provisioned, failed, total: waiting.length },
      'Processed WAITING_FOR_SETUP requests after user completed setup',
    );
    return { provisioned, failed };
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
      include: { group: true, level: true },
    });

    if (!access) throw new NotFoundError('User access grant not found');
    if (!access.isActive) throw new ValidationError('Access is already inactive');

    // 1. Remove from platform Group — resolve via the level the user was actually
    // granted on (falls back to the group for legacy/level-less grants), matching
    // how _provision picked the target.
    const externalUserId = access.externalUserId;
    const externalGroupId = access.level?.externalGroupId ?? access.group.externalGroupId;
    const platform = this.requirePlatform(access.group);

    if (externalUserId && externalGroupId) {
      try {
        const provisioner = provisioningRegistry.get(platform);
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
        details: { reason, userAccessId, levelId: access.levelId ?? null, levelName: access.level?.name ?? null },
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
      include: { group: true, level: true },
    });

    if (!access || !access.isActive) return;

    logger.info(`Expiring temporary access grant ${userAccessId} for user ${access.userName} in group ${access.group.name}...`);

    // 1. Remove from platform Group — resolve via the granted level (falls back to
    // the group for legacy/level-less grants), matching _provision's target.
    const externalUserId = access.externalUserId;
    const externalGroupId = access.level?.externalGroupId ?? access.group.externalGroupId;
    const platform = this.requirePlatform(access.group);

    if (externalUserId && externalGroupId) {
      try {
        const provisioner = provisioningRegistry.get(platform);
        await provisioner.deprovision({ externalUserId, externalGroupId });
      } catch (err: any) {
        const attempts = access.expiryAttempts + 1;
        logger.error(
          `Scheduler failed to deprovision user from platform ${platform} during expiry of ${userAccessId} (attempt ${attempts}/${MAX_EXPIRY_ATTEMPTS}):`,
          err.message,
        );

        if (attempts < MAX_EXPIRY_ATTEMPTS) {
          // Record the failure; the grant stays active so the next cron run retries.
          await prisma.userAccess.update({
            where: { id: userAccessId },
            data: { expiryAttempts: attempts, lastExpiryError: err.message },
          });
          throw err; // surfaced per-grant by the scheduler's allSettled logging
        }

        // Final failure: break the infinite retry loop. Force the grant inactive in
        // Hermes, audit it, and alert admins — the user may still exist on the
        // platform, so it's flagged for manual cleanup rather than silently dropped.
        // Deliberately do NOT re-throw, so the scheduler stops re-fetching this grant.
        await this.forceExpireAfterFailure(access, attempts, err.message, platform);
        return;
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
        details: { userAccessId, levelId: access.levelId ?? null, levelName: access.level?.name ?? null },
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

  /**
   * Final auto-expiry failure handler. Called once a deprovision has failed
   * MAX_EXPIRY_ATTEMPTS times: stop retrying, force the grant inactive, audit a
   * ACCESS_EXPIRY_FAILED entry, and alert admins that the user may still exist on
   * the platform and needs manual cleanup.
   */
  private async forceExpireAfterFailure(
    access: Prisma.UserAccessGetPayload<{ include: { group: true; level: true } }>,
    attempts: number,
    errorMessage: string,
    platform: string,
  ): Promise<void> {
    logger.error(
      `Auto-expiry permanently failed for ${access.id} after ${attempts} attempts — forcing inactive and alerting admins.`,
    );

    await prisma.userAccess.update({
      where: { id: access.id },
      data: {
        isActive: false,
        revokedAt: new Date(),
        expiryAttempts: attempts,
        lastExpiryError: errorMessage,
      },
    });

    if (access.accessRequestId) {
      await prisma.accessRequest.update({
        where: { id: access.accessRequestId },
        data: {
          status: RequestStatus.EXPIRED,
          revokeReason: `Auto-expiry failed after ${attempts} attempts — forced inactive; manual platform cleanup may be required`,
          revokedAt: new Date(),
        },
      });
    }

    await prisma.auditEntry.create({
      data: {
        action: 'ACCESS_EXPIRY_FAILED',
        performerId: 'system_scheduler',
        performerName: 'System Scheduler',
        targetUserId: access.userId,
        targetUserName: access.userName,
        groupId: access.groupId,
        accessRequestId: access.accessRequestId,
        details: {
          userAccessId: access.id,
          attempts,
          error: errorMessage,
          levelId: access.levelId ?? null,
          levelName: access.level?.name ?? null,
          note: 'Deprovision failed repeatedly; grant forced inactive. User may still exist on the platform.',
        },
      },
    });

    eventBus.emitAccessEvent({
      type: 'access.expiry-failed',
      payload: {
        userAccessId: access.id,
        userId: access.userId,
        userName: access.userName,
        groupName: access.group.name,
        platform,
        attempts,
        error: errorMessage,
      },
      timestamp: new Date(),
    });
  }
}

export const accessWorkflowService = new AccessWorkflowService();
export default accessWorkflowService;
