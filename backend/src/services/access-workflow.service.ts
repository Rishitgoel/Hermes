import { randomUUID } from 'crypto';
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
  /**
   * Add months to now, clamping to the last day of the target month so a grant
   * never silently overshoots (Jan 31 + 1 month = Feb 28/29, not Mar 3 — the
   * default setMonth rolls the overflow into the next month).
   */
  private addMonthsClamped(months: number): Date {
    const d = new Date();
    const day = d.getDate();
    d.setMonth(d.getMonth() + months);
    if (d.getDate() !== day) d.setDate(0); // overflowed into the next month → clamp back
    return d;
  }

  private calculateExpiry(duration: AccessDuration): Date | null {
    switch (duration) {
      case AccessDuration.ONE_DAY:
        return new Date(Date.now() + 1 * 24 * 60 * 60 * 1000);
      case AccessDuration.ONE_WEEK:
        return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      case AccessDuration.ONE_MONTH:
        return this.addMonthsClamped(1);
      case AccessDuration.THREE_MONTHS:
        return this.addMonthsClamped(3);
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
   * Request a RENEWAL (extension) of access the user already holds in a group.
   *
   * Unlike createRequest, this is only valid when the user *already* has an active
   * grant — it carries the user's current level forward and goes through the normal
   * admin-approval flow. On approval, _provision detects the existing grant and
   * extends it (deactivate old + create new with a fresh window) rather than
   * creating a parallel grant, so the one-active-grant-per-(user,group) invariant
   * holds and the user keeps their platform membership uninterrupted.
   *
   * Renewals deliberately go through approval (not self-service): letting a user
   * recompute their own expiry window would be a silent self-extension — the same
   * reason a self-service demotion preserves the current expiry.
   */
  async requestRenewal(
    requester: { id: string; username: string; email: string },
    groupId: string,
    justification: string,
    duration: AccessDuration,
  ): Promise<AccessRequest> {
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundError('Group not found');

    // Must already hold active access — otherwise this is a first-time request and
    // belongs in createRequest (which enforces level requiredness and the account gate).
    const currentAccess = await prisma.userAccess.findFirst({
      where: { userId: requester.id, groupId, isActive: true },
    });
    if (!currentAccess) {
      throw new ConflictError(
        'You do not have active access to this group to renew. Request access first.',
      );
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
      throw new ConflictError(
        'You already have a pending request for this group. Wait for it to be reviewed.',
      );
    }

    // A renewal keeps the user on the level they currently hold; carry it onto the
    // request so approval re-provisions the same level (level-less grant ⇒ null).
    let level: LevelRow | null = null;
    if (currentAccess.levelId) {
      level = await prisma.groupLevel.findUnique({
        where: { id: currentAccess.levelId },
        select: { id: true, name: true, slug: true, externalGroupId: true },
      });
    }

    return this._persistPendingRequest(requester, group, level, justification, duration);
  }

  /**
   * Bulk create access requests in ONE round-trip + ONE Prisma transaction.
   * Replaces the frontend's N parallel POSTs (Groups page "Submit Requests").
   *
   * Partial-success by design: each item is validated independently (the same
   * group/level/active-access/open-request checks as createRequest); only the valid
   * items are inserted (atomically, together), and every item — created or skipped —
   * is reported back so the UI can show "3 submitted, 2 skipped: …". One consolidated
   * `requests.bulk.created` event replaces the N per-request events (one Slack ping +
   * one summary per admin instead of N). Per-request REQUEST_CREATED audit rows are
   * still written (each request needs its own trace + accessRequestId FK), correlated
   * by a shared `bulkId` in their details.
   *
   * `duration` is shared across the batch (matches the UI's single duration picker).
   */
  async createRequestsBulk(
    requester: { id: string; username: string; email: string },
    items: { groupId: string; levelId?: string | null; justification: string }[],
    duration: AccessDuration,
  ): Promise<{
    created: { groupId: string; requestId: string; groupName: string; levelName: string | null }[];
    failed: { groupId: string; groupName: string | null; error: string }[];
  }> {
    // De-dupe by groupId (the UI sends unique ids, but this also prevents an
    // intra-batch collision against the open-request unique index).
    const seenGroup = new Set<string>();
    const deduped = items.filter((it) => {
      if (seenGroup.has(it.groupId)) return false;
      seenGroup.add(it.groupId);
      return true;
    });
    const groupIds = deduped.map((it) => it.groupId);

    // Batch-load everything per-item validation needs — no N+1.
    const [groups, activeLevels, activeAccesses, openRequests] = await Promise.all([
      prisma.group.findMany({ where: { id: { in: groupIds } } }),
      prisma.groupLevel.findMany({ where: { groupId: { in: groupIds }, isActive: true } }),
      prisma.userAccess.findMany({
        where: { userId: requester.id, groupId: { in: groupIds }, isActive: true },
        select: { groupId: true },
      }),
      prisma.accessRequest.findMany({
        where: {
          requesterId: requester.id,
          groupId: { in: groupIds },
          status: { in: [RequestStatus.PENDING, RequestStatus.WAITING_FOR_SETUP] },
        },
        select: { groupId: true },
      }),
    ]);

    const groupById = new Map(groups.map((g) => [g.id, g]));
    const levelsByGroup = new Map<string, LevelRow[]>();
    for (const lvl of activeLevels) {
      const arr = levelsByGroup.get(lvl.groupId) ?? [];
      arr.push(lvl);
      levelsByGroup.set(lvl.groupId, arr);
    }
    const hasActiveAccess = new Set(activeAccesses.map((a) => a.groupId));
    const hasOpenRequest = new Set(openRequests.map((r) => r.groupId));

    const expiresAt = this.calculateExpiry(duration);
    const valid: { group: GroupRow; level: LevelRow | null; justification: string }[] = [];
    const failed: { groupId: string; groupName: string | null; error: string }[] = [];

    for (const it of deduped) {
      const group = groupById.get(it.groupId);
      if (!group) {
        failed.push({ groupId: it.groupId, groupName: null, error: 'Group not found' });
        continue;
      }
      const fail = (error: string) => failed.push({ groupId: it.groupId, groupName: group.name, error });

      // Level requiredness — mirrors createRequest exactly.
      const levels = levelsByGroup.get(it.groupId) ?? [];
      let level: LevelRow | null = null;
      if (levels.length > 0) {
        if (!it.levelId) {
          fail('This group requires selecting a level.');
          continue;
        }
        level = levels.find((l) => l.id === it.levelId) ?? null;
        if (!level) {
          fail('Invalid or inactive level for this group.');
          continue;
        }
        if (!level.externalGroupId) {
          fail('This level is not fully configured yet (no backing platform group). Please contact an admin.');
          continue;
        }
      } else if (it.levelId) {
        fail('This group has no levels; do not specify a level.');
        continue;
      }

      if (hasActiveAccess.has(it.groupId)) {
        fail('You already have active access to this group.');
        continue;
      }
      if (hasOpenRequest.has(it.groupId)) {
        fail('You already have a pending request for this group.');
        continue;
      }

      valid.push({ group, level, justification: it.justification });
    }

    if (valid.length === 0) {
      return { created: [], failed };
    }

    // Insert all valid requests + their per-request audit rows atomically, correlated
    // by a shared bulkId. A concurrent submit (another tab) could still trip the
    // open-request unique index mid-transaction and roll the whole batch back — surface
    // that as a retryable conflict rather than silently dropping the valid items.
    const bulkId = randomUUID();
    let createdRows: { request: AccessRequest; group: GroupRow; level: LevelRow | null }[];
    try {
      createdRows = await prisma.$transaction(async (tx) => {
        const out: { request: AccessRequest; group: GroupRow; level: LevelRow | null }[] = [];
        for (const v of valid) {
          const request = await tx.accessRequest.create({
            data: {
              groupId: v.group.id,
              levelId: v.level?.id ?? null,
              requesterId: requester.id,
              requesterName: requester.username,
              requesterEmail: requester.email,
              justification: v.justification,
              duration,
              expiresAt,
              status: RequestStatus.PENDING,
            },
          });
          await tx.auditEntry.create({
            data: {
              action: 'REQUEST_CREATED',
              performerId: requester.id,
              performerName: requester.username,
              targetUserId: requester.id,
              targetUserName: requester.username,
              groupId: v.group.id,
              accessRequestId: request.id,
              details: {
                duration,
                expiresAt,
                levelId: v.level?.id ?? null,
                levelName: v.level?.name ?? null,
                bulkId,
                bulk: true,
              },
            },
          });
          out.push({ request, group: v.group, level: v.level });
        }
        return out;
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictError(
          'One of these requests was just submitted elsewhere — please refresh and retry.',
        );
      }
      throw err;
    }

    // One consolidated event for the whole batch (replaces N request.created events).
    eventBus.emitAccessEvent({
      type: 'requests.bulk.created',
      payload: {
        requesterId: requester.id,
        requesterName: requester.username,
        duration,
        items: createdRows.map((r) => ({
          requestId: r.request.id,
          groupId: r.group.id,
          groupName: r.group.name,
          levelName: r.level?.name ?? null,
        })),
      },
      timestamp: new Date(),
    });

    return {
      created: createdRows.map((r) => ({
        groupId: r.group.id,
        requestId: r.request.id,
        groupName: r.group.name,
        levelName: r.level?.name ?? null,
      })),
      failed,
    };
  }

  /**
   * Persist a PENDING access request + its REQUEST_CREATED audit row, and notify
   * admins. Shared by the first-time request flow (createRequest) and renewals
   * (requestRenewal). Both produce an identical "awaiting admin review" request —
   * the only difference upstream is the guard logic that decides whether a request
   * is allowed.
   */
  private async _persistPendingRequest(
    requester: { id: string; username: string; email: string },
    group: { id: string; name: string },
    level: LevelRow | null,
    justification: string,
    duration: AccessDuration,
  ): Promise<AccessRequest> {
    const expiresAt = this.calculateExpiry(duration);

    let request: AccessRequest;
    try {
      request = await prisma.accessRequest.create({
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
    } catch (err: any) {
      // Partial unique index (requester_id, group_id) WHERE status IN
      // (PENDING, WAITING_FOR_SETUP) fired: a concurrent submit (double-click,
      // second tab) slipped past the check-then-create above. Surface it the same
      // way the precheck would have.
      if (err?.code === 'P2002') {
        throw new ConflictError('You already have a pending request for this group.');
      }
      throw err;
    }

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
   * _provision, no re-fetch). Shared by adminSetMemberLevel and adminAddMember —
   * both create an
   * immediately-provisioned request whose reviewer is the performer; only the
   * copy/audit details differ. `level` is null for a level-less group's grant.
   */
  private async _persistSelfReviewedRequest(opts: {
    performer: { id: string; username: string };
    target: { id: string; name: string; email: string };
    groupId: string;
    level: { id: string; name: string } | null;
    justification: string;
    duration: AccessDuration;
    reviewNote: string;
    auditDetails: Record<string, unknown>;
  }): Promise<AccessRequestWithGroup> {
    const expiresAt = this.calculateExpiry(opts.duration);
    const created = await prisma.accessRequest.create({
      data: {
        groupId: opts.groupId,
        levelId: opts.level?.id ?? null,
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
          levelId: opts.level?.id ?? null,
          levelName: opts.level?.name ?? null,
          ...opts.auditDetails,
        },
      },
    });

    return created;
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

  /**
   * Admin override: add a user to a group directly from Admin Management — no
   * pending request to review (the performer is recorded as the reviewer). The
   * same validations as a normal request apply (level requiredness, one active
   * grant per group, one open request per group), and the same per-platform
   * account gate as reviewRequest: a user with no approved account on this
   * group's platform can't be added; one whose account is approved but not yet
   * finalized is queued (WAITING_FOR_SETUP) and provisions automatically when
   * their setup completes; a COMPLETED account provisions immediately.
   */
  async adminAddMember(
    performer: { id: string; username: string },
    target: { id: string; name: string; email: string },
    groupId: string,
    levelId: string | null,
    duration: AccessDuration,
  ): Promise<{ kind: 'provisioned' | 'queued'; request: AccessRequest }> {
    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundError('Group not found');

    // Level requiredness — mirrors createRequest exactly.
    const activeLevels = await prisma.groupLevel.findMany({ where: { groupId, isActive: true } });
    let level: LevelRow | null = null;
    if (activeLevels.length > 0) {
      if (!levelId) throw new ValidationError('This group requires selecting a level.');
      level = activeLevels.find((l) => l.id === levelId) ?? null;
      if (!level) throw new ValidationError('Invalid or inactive level for this group.');
      if (!level.externalGroupId) {
        throw new ValidationError('This level is not fully configured yet (no backing platform group). Configure it first.');
      }
    } else if (levelId) {
      throw new ValidationError('This group has no levels; do not specify a level.');
    }

    const activeAccess = await prisma.userAccess.findFirst({
      where: { userId: target.id, groupId, isActive: true },
    });
    if (activeAccess) {
      throw new ConflictError('This user is already an active member of this group.');
    }

    const openRequest = await prisma.accessRequest.findFirst({
      where: {
        requesterId: target.id,
        groupId,
        status: { in: [RequestStatus.PENDING, RequestStatus.WAITING_FOR_SETUP] },
      },
    });
    if (openRequest) {
      throw new ConflictError('This user already has an open request for this group — review that request instead.');
    }

    // Per-platform account gate — same bar as reviewRequest's APPROVED branch.
    const platform = this.requirePlatform(group);
    const userCreation = await prisma.userCreationRequest.findUnique({
      where: { userId_platform: { userId: target.id, platform } },
    });
    const isApprovedOrLater =
      userCreation &&
      (userCreation.status === UserCreationStatus.APPROVED ||
        userCreation.status === UserCreationStatus.AWAITING_SETUP ||
        userCreation.status === UserCreationStatus.COMPLETED);
    if (!isApprovedOrLater) {
      throw new UserNotApprovedError(
        `Cannot add this user — they are not yet an approved Hermes user on ${platform}. A super admin must approve their ${platform} account request first.`,
        { userCreationStatus: userCreation?.status ?? 'MISSING', platform },
      );
    }

    const justification = `Added by ${performer.username} via Admin Management`;
    const reviewNote = 'Added directly by admin';

    // Account approved but not finalized → queue. provisionWaitingRequests releases
    // it (and provisions) once the user's platform setup completes.
    if (userCreation.status !== UserCreationStatus.COMPLETED) {
      let queued: AccessRequest;
      try {
        queued = await prisma.accessRequest.create({
          data: {
            groupId,
            levelId: level?.id ?? null,
            requesterId: target.id,
            requesterName: target.name,
            requesterEmail: target.email,
            justification,
            duration,
            expiresAt: this.calculateExpiry(duration),
            status: RequestStatus.WAITING_FOR_SETUP,
            reviewerId: performer.id,
            reviewerName: performer.username,
            reviewNote,
            reviewedAt: new Date(),
          },
        });
      } catch (err: any) {
        // Partial unique open-request index fired (a concurrent submit slipped past
        // the check above) — surface it the same way the precheck would have.
        if (err?.code === 'P2002') {
          throw new ConflictError('This user already has an open request for this group — review that request instead.');
        }
        throw err;
      }

      await prisma.auditEntry.create({
        data: {
          action: 'ACCESS_QUEUED_FOR_SETUP',
          performerId: performer.id,
          performerName: performer.username,
          targetUserId: target.id,
          targetUserName: target.name,
          groupId,
          accessRequestId: queued.id,
          details: {
            adminAdded: true,
            userCreationStatus: userCreation.status,
            duration,
            levelId: level?.id ?? null,
            levelName: level?.name ?? null,
          },
        },
      });

      eventBus.emitAccessEvent({
        type: 'access.queued-for-setup',
        payload: {
          requesterId: target.id,
          groupName: group.name,
          reviewerName: performer.username,
          platform,
        },
        timestamp: new Date(),
      });

      return { kind: 'queued', request: queued };
    }

    // Account ready → provision immediately via the shared self-reviewed machinery.
    const fullRequest = await this._persistSelfReviewedRequest({
      performer,
      target,
      groupId,
      level,
      justification,
      duration,
      reviewNote,
      auditDetails: { adminAdded: true },
    });
    const provisioned = await this._provision(fullRequest, { id: performer.id, name: performer.username });
    return { kind: 'provisioned', request: provisioned };
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
        `Cannot approve this request — the requester is not yet an approved Hermes user on ${platform}. A super admin must approve their ${platform} account request first.`,
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

  /**
   * The external-group mapping of every OTHER active grant `userId` holds on `platform`
   * (excluding the grant `excludeUserAccessId` being removed), newline-joined. Passed as
   * `retainExternalGroupId` to a revoke/expire deprovision so a multi-target adapter
   * (ZooKeeper, whose externalGroupId is a list of znode paths) does NOT strip a path the
   * user still legitimately accesses through a different group. Single-target adapters
   * (Redash/AWS) ignore the hint, and their group ids never overlap anyway, so it's a
   * safe no-op there. Returns undefined when there are no other grants.
   */
  async collectRetainedExternalGroupIds(args: {
    keys: string[];
    platform: string;
    keyType: 'email' | 'userId';
    excludeGroupId?: string;
    excludeUserAccessIds?: string[];
  }): Promise<Map<string, string[]>> {
    const { keys, platform, keyType, excludeGroupId, excludeUserAccessIds } = args;
    const keyField = keyType === 'email' ? 'userEmail' : 'userId';
    const others = await prisma.userAccess.findMany({
      where: {
        [keyField]: { in: keys },
        isActive: true,
        group: { platform },
        ...(excludeGroupId ? { groupId: { not: excludeGroupId } } : {}),
        ...(excludeUserAccessIds ? { id: { notIn: excludeUserAccessIds } } : {}),
      },
      include: { group: true, level: true },
    });
    const byKey = new Map<string, string[]>();
    for (const k of keys) {
      byKey.set(k, []);
    }
    for (const a of others) {
      const externalId = a.level?.externalGroupId ?? a.group.externalGroupId;
      if (!externalId) continue;
      const key = keyType === 'email' ? a.userEmail : a.userId;
      const list = byKey.get(key) ?? [];
      list.push(externalId);
      byKey.set(key, list);
    }
    return byKey;
  }

  private async collectRetainedExternalGroupId(
    userId: string,
    platform: string,
    excludeUserAccessId: string,
  ): Promise<string | undefined> {
    const map = await this.collectRetainedExternalGroupIds({
      keys: [userId],
      platform,
      keyType: 'userId',
      excludeUserAccessIds: [excludeUserAccessId],
    });
    const ids = map.get(userId) ?? [];
    return ids.length ? ids.join('\n') : undefined;
  }

  private async deprovisionWithRetain(
    userId: string,
    platform: string,
    userAccessId: string,
    externalUserId: string,
    externalGroupId: string,
  ): Promise<void> {
    const provisioner = provisioningRegistry.get(platform);
    const retainExternalGroupId = provisioner.reconcileMembers
      ? await this.collectRetainedExternalGroupId(userId, platform, userAccessId)
      : undefined;
    await provisioner.deprovision({ externalUserId, externalGroupId, retainExternalGroupId });
  }

  private async _provision(
    request: AccessRequestWithGroup,
    performer: { id: string; name: string },
    note?: string,
  ) {
    logger.info(`Starting provisioning for request ${request.id}...`);

    // Set once the platform-side provision call has succeeded. If a LATER step
    // fails (e.g. the level-swap transaction aborts on a concurrent revoke), the
    // user has already been added to the external group with no Hermes grant
    // backing it — flag that in the failure audit so it can be cleaned up manually.
    let platformProvisioned: { externalUserId: string; externalGroupId: string } | null = null;

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
        userId: request.requesterId,
        externalGroupId,
        metadata: { groupSlug: request.group.slug, levelSlug: request.level?.slug ?? null },
      });
      const externalUserId = result.externalUserId;
      platformProvisioned = { externalUserId, externalGroupId };

      // Recompute expiry at provision time using the request's duration. Using the
      // value stored on AccessRequest (computed at request-create time) means a
      // 1-day request approved 3 days later would expire immediately.
      const grantedAt = new Date();
      const expiresAt = this.calculateExpiry(request.duration);

      // A pre-existing active grant created by a DIFFERENT (older) request means this
      // request is meant to replace it → swap (atomically deactivate the old grant +
      // create the new one). Two cases land here:
      //   - different level → level change (remove user from the old level's group).
      //   - same level      → renewal: same external group, so _swapGrant skips the
      //     platform deprovision and the user keeps membership with a fresh expiry.
      // A grant created by THIS SAME request (accessRequestId === request.id) is a
      // genuine concurrent duplicate (double-provision of one request) and is left to
      // the P2002 short-circuit in the create branch below — not a swap.
      const existingGrant = await prisma.userAccess.findFirst({
        where: { userId: request.requesterId, groupId: request.groupId, isActive: true },
        include: { level: true },
      });
      if (existingGrant && existingGrant.accessRequestId !== request.id) {
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
          details: {
            error: err.message,
            // The platform call succeeded before a later step failed: the user may
            // sit in the external group with no Hermes grant. Surfaced here (not
            // auto-rolled-back: blindly deprovisioning could remove a membership a
            // still-active grant legitimately points at, e.g. when a level shares
            // the base group's external group).
            ...(platformProvisioned
              ? {
                  orphanedPlatformMembership: true,
                  ...platformProvisioned,
                  note: 'Platform provision succeeded before the failure — the user may remain in the external group; manual cleanup may be required.',
                }
              : {}),
          },
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
    // Same level being re-granted = a renewal (extend the expiry), not a level change.
    // Drives the request/audit wording below; the platform deprovision is skipped
    // anyway because both levels resolve to the same external group.
    const isRenewal = existingGrant.levelId === request.levelId;

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
            revokeReason: isRenewal
              ? 'Superseded by access renewal'
              : `Superseded by level change to "${request.level?.name ?? 'another level'}"`,
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
    // from the OLD level's external group on the platform. `retainExternalGroupId`
    // tells a multi-target adapter (ZooKeeper) to KEEP any target the NEW mapping still
    // grants, so swapping into a level that shares paths never strips a shared path
    // (the new provision above already re-applied its perms). The old===new guard still
    // short-circuits a same-level renewal for single-target adapters (which ignore the
    // hint and would otherwise drop the one shared group).
    let oldDeprovisionError: string | null = null;
    if (existingGrant.externalUserId && oldExternalGroupId && oldExternalGroupId !== newExternalGroupId) {
      // Keep every target the user still legitimately holds after the swap: the NEW
      // mapping (this group's new level) AND every OTHER active grant on this platform —
      // so a shared ZooKeeper znode path held via a DIFFERENT group is not stripped.
      // (Mirrors revoke/expire; a no-op for single-target adapters, which ignore the hint.)
      // Without the cross-group union, swapping a level in one group would silently revoke
      // a path another group still grants. We exclude the just-created grant from the
      // query (it's the new mapping, added explicitly) and the old grant is already
      // deactivated above, so the query returns only the user's OTHER groups. Skip the
      // query for single-target adapters (no reconcileMembers) — they ignore the hint.
      const crossGroupRetain = provisioner.reconcileMembers
        ? await this.collectRetainedExternalGroupId(request.requesterId, platform, newAccess.id)
        : undefined;
      const retainExternalGroupId = [newExternalGroupId, crossGroupRetain].filter(Boolean).join('\n');
      try {
        await provisioner.deprovision({
          externalUserId: existingGrant.externalUserId,
          externalGroupId: oldExternalGroupId,
          retainExternalGroupId,
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
          // Same level re-granted with a fresh window = a renewal; a different level = a level change.
          action: isRenewal ? 'ACCESS_RENEWED' : 'ACCESS_LEVEL_CHANGED',
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
            ...(isRenewal ? { renewal: true, newExpiresAt: expiresAt } : {}),
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
          // Stamp the system as reviewer so rejected rows don't show an empty
          // "reviewed by" in the UI (the audit entry below carries the same).
          reviewerId: 'system_cascade',
          reviewerName: 'System (cascade reject)',
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

    // 1. Disable UserAccess entry FIRST
    const updatedAccess = await prisma.userAccess.update({
      where: { id: userAccessId },
      data: {
        isActive: false,
        revokedAt: new Date(),
      },
    });

    if (externalUserId && externalGroupId) {
      try {
        await this.deprovisionWithRetain(access.userId, platform, userAccessId, externalUserId, externalGroupId);
      } catch (err: any) {
        logger.error(`Failed to deprovision user from platform ${platform} during revocation of ${userAccessId}:`, err.message);
        if (!force) {
          // A genuinely-absent membership (user removed from the group, or deleted,
          // directly on the platform) is NOT a failure: the adapters' deprovision
          // paths are idempotent — Redash/AWS both tolerate an already-gone
          // membership and return cleanly. So a throw here means a real, likely
          // transient platform error; roll back the deactivation and surface it
          // rather than silently dropping a grant the user may still hold.
          await prisma.userAccess.update({
            where: { id: userAccessId },
            data: {
              isActive: true,
              revokedAt: null,
            },
          });
          throw err;
        }
      }
    }

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
        details: {
          reason,
          userAccessId,
          levelId: access.levelId ?? null,
          levelName: access.level?.name ?? null,
        },
      },
    });

    // 5. Notify Requester via Event Bus
    eventBus.emitAccessEvent({
      type: 'access.revoked',
      payload: {
        userId: access.userId,
        userEmail: access.userEmail,
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

    const externalUserId = access.externalUserId;
    const externalGroupId = access.level?.externalGroupId ?? access.group.externalGroupId;
    const platform = this.requirePlatform(access.group);

    // 1. Disable UserAccess entry FIRST
    await prisma.userAccess.update({
      where: { id: userAccessId },
      data: {
        isActive: false,
        revokedAt: new Date(),
      },
    });

    if (externalUserId && externalGroupId) {
      try {
        await this.deprovisionWithRetain(access.userId, platform, userAccessId, externalUserId, externalGroupId);
      } catch (err: any) {
        const attempts = access.expiryAttempts + 1;
        logger.error(
          `Scheduler failed to deprovision user from platform ${platform} during expiry of ${userAccessId} (attempt ${attempts}/${MAX_EXPIRY_ATTEMPTS}):`,
          err.message,
        );

        if (attempts < MAX_EXPIRY_ATTEMPTS) {
          // Revert deactivation and record the failure; the grant stays active so the next cron run retries.
          await prisma.userAccess.update({
            where: { id: userAccessId },
            data: {
              isActive: true,
              revokedAt: null,
              expiryAttempts: attempts,
              lastExpiryError: err.message,
            },
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
        userEmail: access.userEmail,
        groupName: access.group.name,
      },
      timestamp: new Date(),
    });
  }

  // Pre-expiry heads-up (Scheduler Job). Marks the grant warned so the daily sweep
  // never re-notifies it, then fires the notification. No-op if the grant already
  // expired/was revoked, or was warned, since the last sweep.
  async warnExpiringAccess(userAccessId: string) {
    const access = await prisma.userAccess.findUnique({
      where: { id: userAccessId },
      include: { group: true },
    });

    if (!access || !access.isActive || access.expiryWarnedAt) return;

    await prisma.userAccess.update({
      where: { id: userAccessId },
      data: { expiryWarnedAt: new Date() },
    });

    eventBus.emitAccessEvent({
      type: 'access.expiring',
      payload: {
        userId: access.userId,
        userEmail: access.userEmail,
        groupName: access.group.name,
        expiresAt: access.expiresAt,
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
