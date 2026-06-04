import prisma from '../config/prisma';
import provisioningRegistry from './provisioning.registry';
import eventBus from './event-bus';
import logger from '../utils/logger';
import { AccessDuration, AccessRequest, RequestStatus, UserCreationStatus } from '@prisma/client';
import { ValidationError, NotFoundError, ConflictError, UserNotApprovedError } from '../utils/errors';

type GroupRow = { id: string; name: string; slug: string; platform: string; externalGroupId: string | null };
type LevelRow = { id: string; name: string; slug: string; externalGroupId: string | null };
type AccessRequestWithGroup = AccessRequest & { group: GroupRow; level?: LevelRow | null };

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

    const expiresAt = this.calculateExpiry(duration);

    const request = await prisma.accessRequest.create({
      data: {
        groupId,
        levelId: levelId ?? null,
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
        details: { duration, expiresAt, levelId: level?.id ?? null, levelName: level?.name ?? null },
      },
    });

    // Notify admins via Event Bus
    eventBus.emitAccessEvent({
      type: 'request.created',
      payload: {
        requestId: request.id,
        groupId,
        groupName: level ? `${group.name} — ${level.name}` : group.name,
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

    // Status: APPROVED → gate on user-creation status, then either provision or queue.
    const userCreation = await prisma.userCreationRequest.findUnique({
      where: { userId: request.requesterId },
    });

    // No user-creation row, or it isn't past the admin-approval bar → block.
    const isApprovedOrLater =
      userCreation &&
      (userCreation.status === UserCreationStatus.APPROVED ||
        userCreation.status === UserCreationStatus.AWAITING_SETUP ||
        userCreation.status === UserCreationStatus.COMPLETED);

    if (!isApprovedOrLater) {
      throw new UserNotApprovedError(
        'Cannot approve this request — the requester is not yet an approved Hermes user. Approve their user-creation request first.',
        { userCreationStatus: userCreation?.status ?? 'MISSING' },
      );
    }

    // User-creation approved but Redash account not finalized yet → queue for setup completion.
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

      // A level (if any) owns its own external group; fall back to the group's own
      // externalGroupId for level-less (legacy) groups.
      const externalGroupId = request.level?.externalGroupId ?? request.group.externalGroupId;
      if (!externalGroupId) {
        throw new Error(
          `Group ${request.group.name}${request.level ? ` / level ${request.level.name}` : ''} has no associated External Group ID configured`,
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
   * Bulk-reject all of a user's PENDING + WAITING_FOR_SETUP group requests in one transaction.
   * Called from user-creation service when an admin rejects a user-creation request.
   */
  async cascadeRejectForUser(userId: string, note: string): Promise<number> {
    const toReject = await prisma.accessRequest.findMany({
      where: {
        requesterId: userId,
        status: { in: [RequestStatus.PENDING, RequestStatus.WAITING_FOR_SETUP] },
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
  async provisionWaitingRequests(userId: string): Promise<{ provisioned: number; failed: number }> {
    const waiting = await prisma.accessRequest.findMany({
      where: {
        requesterId: userId,
        status: RequestStatus.WAITING_FOR_SETUP,
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

  /**
   * Ensure a direct group admin actually holds real membership in the groups they
   * administer. The Groups list shows admins as ACTIVE (a cosmetic short-circuit in
   * group.controller), but that's not a real grant — this creates the UserAccess
   * row + provisions them on the platform so they're an actual member on Redash.
   *
   * Platform admins and super admins are intentionally excluded by callers: they
   * can manage groups without being mass-provisioned into every external group.
   *
   * Called lazily from GET /auth/me once the user's Redash account is COMPLETED,
   * since that's the only point where we have both their resolved admin scopes
   * and a finalized platform account. Idempotent and self-healing: skips any
   * group where an active grant already exists, the group is missing/inactive, or
   * it has no externalGroupId. Per-slug try/catch so one failure doesn't block the
   * rest. `reason` is recorded on each enrollment's audit entry.
   */
  async ensureGroupAdminEnrollment(
    user: { id: string; username: string; email: string },
    adminGroupSlugs: string[],
    reason: string = 'Group-admin auto-enrollment',
  ): Promise<{ enrolled: number }> {
    if (adminGroupSlugs.length === 0) return { enrolled: 0 };

    let enrolled = 0;
    for (const slug of adminGroupSlugs) {
      try {
        const created = await this.enrollGroupAdminInGroup(user, slug, reason);
        if (created) enrolled += 1;
      } catch (err: any) {
        logger.error(
          { userId: user.id, slug, error: err.message },
          'Failed to auto-enroll group-admin into their group',
        );
      }
    }
    return { enrolled };
  }

  /** Provision + record a single group-admin auto-enrollment. Returns true if a
   *  new grant was created, false if it was a no-op (already a member, group not
   *  provisionable, etc.). */
  private async enrollGroupAdminInGroup(
    user: { id: string; username: string; email: string },
    slug: string,
    reason: string = 'Group-admin auto-enrollment',
  ): Promise<boolean> {
    const group = await prisma.group.findUnique({ where: { slug } });
    if (!group || !group.isActive) return false;

    // Already a real member → nothing to do (idempotent across repeated logins).
    const existing = await prisma.userAccess.findFirst({
      where: { userId: user.id, groupId: group.id, isActive: true },
    });
    if (existing) return false;

    // If the group has levels, enroll the admin into the highest-rank (most
    // privileged) active level — they should hold the strongest access in the
    // group they administer. Level-less groups fall back to the group itself.
    const levels = await prisma.groupLevel.findMany({
      where: { groupId: group.id, isActive: true },
      orderBy: { rank: 'desc' },
    });
    const level = levels[0] ?? null;
    const externalGroupId = level?.externalGroupId ?? group.externalGroupId;

    if (!externalGroupId) {
      logger.warn(
        { slug, groupId: group.id, levelId: level?.id ?? null },
        'Skipping group-admin auto-enroll — no externalGroupId configured for the group/level',
      );
      return false;
    }

    const platform = this.requirePlatform(group);
    const provisioner = provisioningRegistry.get(platform);

    const result = await provisioner.provision({
      email: user.email,
      name: user.username,
      externalGroupId,
      metadata: { groupSlug: group.slug, levelSlug: level?.slug ?? null },
    });

    const performer = { id: 'system_admin_enroll', name: 'System (admin auto-enroll)' };

    try {
      const userAccess = await prisma.userAccess.create({
        data: {
          userId: user.id,
          userName: user.username,
          userEmail: user.email,
          groupId: group.id,
          levelId: level?.id ?? null,
          externalUserId: result.externalUserId,
          isActive: true,
          grantedAt: new Date(),
          expiresAt: null, // group-admin enrollment is permanent
          grantedBy: performer.name,
          accessRequestId: null, // no AccessRequest — assignment came from Keycloak
        },
      });

      await prisma.auditEntry.create({
        data: {
          action: 'ACCESS_GRANTED',
          performerId: performer.id,
          performerName: performer.name,
          targetUserId: user.id,
          targetUserName: user.username,
          groupId: group.id,
          details: {
            userAccessId: userAccess.id,
            platform,
            externalUserId: result.externalUserId,
            externalGroupId,
            levelId: level?.id ?? null,
            levelName: level?.name ?? null,
            reason,
          },
        },
      });

      logger.info(
        { userId: user.id, slug, groupId: group.id },
        '✅ Auto-enrolled group-admin into their group',
      );
      return true;
    } catch (createErr: any) {
      // Concurrent enroll: partial unique (user_id, group_id) WHERE is_active = true
      // fired. Treat as already provisioned, mirroring _provision's P2002 handling.
      if (createErr?.code === 'P2002') {
        logger.info(
          { userId: user.id, slug },
          'Group-admin already enrolled concurrently — skipping',
        );
        return false;
      }
      throw createErr;
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
}

export const accessWorkflowService = new AccessWorkflowService();
export default accessWorkflowService;
