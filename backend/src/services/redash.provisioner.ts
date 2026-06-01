import {
  PlatformAdapter,
  ProvisionContext,
  ProvisionResult,
  DeprovisionContext,
  PlatformUserStatus,
} from './provisioner.interface';
import redashService from './redash.service';
import prisma from '../config/prisma';
import logger from '../utils/logger';

/**
 * Platform key this adapter is registered under. The provisioning registry,
 * the cache rows in `platform_external_*`, and `Group.platform` all use this
 * exact lowercase string to route to this adapter.
 */
const PLATFORM = 'redash';

/**
 * Redash implementation of {@link PlatformAdapter}.
 *
 * Fulfills the platform-agnostic adapter contract against Redash's HTTP API
 * (via {@link redashService}). All cached state lives in the shared
 * `platform_external_users` / `platform_external_groups` tables, tagged with
 * `platform = "redash"` — there are no Redash-specific tables anymore, so a
 * second adapter (AWS, Jira) slots in alongside without schema changes.
 *
 * Redash IDs are integers on the wire; the generic cache stores `externalId`
 * as a string, so this adapter converts at the boundary (`String(id)` when
 * writing, `parseInt(id, 10)` when calling the Redash API).
 */
export class RedashProvisioner implements PlatformAdapter {
  readonly platform = PLATFORM;

  // ── Provisioning lifecycle ────────────────────────────────────────────────

  /** Ensure the user exists on Redash, then add them to the target group. */
  async provision(ctx: ProvisionContext): Promise<ProvisionResult> {
    const { id: redashUserId } = await redashService.findOrInviteUser(ctx.email, ctx.name);
    if (ctx.externalGroupId) {
      await redashService.addUserToGroup(redashUserId, parseInt(ctx.externalGroupId, 10));
    }
    return { externalUserId: redashUserId.toString() };
  }

  /** Remove the user from the target group on Redash. */
  async deprovision(ctx: DeprovisionContext): Promise<void> {
    if (ctx.externalGroupId) {
      await redashService.removeUserFromGroup(
        parseInt(ctx.externalUserId, 10),
        parseInt(ctx.externalGroupId, 10),
      );
    }
  }

  /** Look up whether a user exists on Redash, using the local cache. */
  async checkUserStatus(email: string): Promise<PlatformUserStatus> {
    const cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: PLATFORM, email: email.toLowerCase() } },
    });
    return {
      exists: !!cached,
      externalUserId: cached?.externalId,
      email,
    };
  }

  /** Invite a brand-new user to Redash and seed a cache row for them. */
  async inviteUser(email: string, name: string): Promise<ProvisionResult> {
    const { id: redashUserId } = await redashService.findOrInviteUser(email, name);
    const externalId = redashUserId.toString();
    await prisma.platformExternalUser.upsert({
      where: { platform_externalId: { platform: PLATFORM, externalId } },
      update: {
        name,
        email: email.toLowerCase(),
        isPending: true,
        lastSyncedAt: new Date(),
      },
      create: {
        platform: PLATFORM,
        externalId,
        name,
        email: email.toLowerCase(),
        isDisabled: false,
        isPending: true,
        externalGroupIds: ['1'], // Redash "default" group
        lastSyncedAt: new Date(),
      },
    });
    return { externalUserId: externalId };
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    try {
      await redashService.syncGroups(); // lightweight probe against the Redash API
      return { healthy: true };
    } catch (err: any) {
      return { healthy: false, message: err.message };
    }
  }

  // ── Sync (cache refresh) ──────────────────────────────────────────────────
  // These own the Redash-specific cache-population logic. The platform-agnostic
  // SyncService orchestrator invokes them via the adapter interface; it does not
  // know anything about Redash's API shape.

  /** Pull all Redash groups into the cache and prune ones that disappeared. */
  async syncGroups(): Promise<{ count: number }> {
    const now = new Date();
    const redashGroups = await redashService.syncGroups();
    logger.info(`🔄 RedashProvisioner: Fetched ${redashGroups.length} groups from Redash.`);

    for (const group of redashGroups) {
      const externalId = group.id.toString();
      await prisma.platformExternalGroup.upsert({
        where: { platform_externalId: { platform: PLATFORM, externalId } },
        update: { name: group.name, type: group.type, lastSyncedAt: now },
        create: { platform: PLATFORM, externalId, name: group.name, type: group.type, lastSyncedAt: now },
      });
    }

    // Drop groups that no longer exist on Redash.
    const activeIds = redashGroups.map(g => g.id.toString());
    await prisma.platformExternalGroup.deleteMany({
      where: { platform: PLATFORM, externalId: { notIn: activeIds } },
    });

    return { count: redashGroups.length };
  }

  /**
   * Pull all Redash users into the cache, prune deleted ones, recompute group
   * member counts, and advance any pending user-creation requests for users who
   * have finished signing up.
   */
  async syncUsers(): Promise<{ count: number }> {
    const now = new Date();
    const redashUsers = await redashService.syncUsers();
    logger.info(`🔄 RedashProvisioner: Fetched ${redashUsers.length} users from Redash.`);

    for (const user of redashUsers) {
      await this.upsertUserRow(user, now);
    }

    // Remove users that no longer exist on Redash.
    const activeIds = redashUsers.map(u => u.id.toString());
    await prisma.platformExternalUser.deleteMany({
      where: { platform: PLATFORM, externalId: { notIn: activeIds } },
    });

    await this.recomputeGroupMemberCounts();
    await this.notifyUserCreationWorkflow(redashUsers);

    return { count: redashUsers.length };
  }

  /**
   * Fast path used by the "I've finished setup — sync now" button: refresh a
   * single user by email instead of pulling the whole directory.
   * Returns false if the user isn't on Redash yet.
   */
  async syncSingleUser(email: string): Promise<boolean> {
    const user = await redashService.fetchUserByEmail(email);
    if (!user) {
      logger.warn({ email }, '🔄 RedashProvisioner: User not found in Redash during single sync.');
      return false;
    }
    await this.upsertUserRow(user, new Date());
    if (!user.is_disabled) {
      await this.notifyUserCreationWorkflow([user]);
    }
    return true;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** Upsert one Redash user into the generic cache. */
  private async upsertUserRow(
    user: { id: number; name: string; email: string; is_disabled: boolean; is_invitation_pending: boolean; groups: number[] },
    now: Date,
  ): Promise<void> {
    const externalId = user.id.toString();
    const row = {
      name: user.name,
      email: user.email.toLowerCase(),
      isDisabled: user.is_disabled,
      isPending: user.is_invitation_pending,
      externalGroupIds: user.groups.map(String),
      metadata: { groupIds: user.groups }, // keep the original int IDs for Redash-specific callers
      lastSyncedAt: now,
    };
    await prisma.platformExternalUser.upsert({
      where: { platform_externalId: { platform: PLATFORM, externalId } },
      update: row,
      create: { platform: PLATFORM, externalId, ...row },
    });
  }

  /** Recompute and persist member counts for every cached Redash group. */
  private async recomputeGroupMemberCounts(): Promise<void> {
    const [groups, users] = await Promise.all([
      prisma.platformExternalGroup.findMany({ where: { platform: PLATFORM } }),
      prisma.platformExternalUser.findMany({ where: { platform: PLATFORM } }),
    ]);
    const updates = groups.map(group => {
      const count = users.filter(u => u.externalGroupIds.includes(group.externalId)).length;
      return prisma.platformExternalGroup.update({
        where: { id: group.id },
        data: { memberCount: count },
      });
    });
    await prisma.$transaction(updates);
  }

  /**
   * Notify the user-creation workflow about every active Redash user so any
   * APPROVED/AWAITING_SETUP request can advance to COMPLETED. Loaded lazily to
   * avoid a static import cycle (user-creation → sync → registry → this adapter).
   * The handler is a cheap no-op for users with no pending request; per-user
   * try/catch so one failure can't break the rest of the batch.
   */
  private async notifyUserCreationWorkflow(
    users: Array<{ id: number; email: string; name: string; is_disabled?: boolean; is_invitation_pending: boolean }>,
  ): Promise<void> {
    const { default: userCreationService } = await import('./user-creation.service');
    for (const u of users) {
      if (u.is_disabled) continue;
      try {
        await userCreationService.handleRedashUserDetected({
          id: u.id,
          email: u.email,
          name: u.name,
          isInvitationPending: u.is_invitation_pending,
        });
      } catch (err: any) {
        logger.error(
          { redashUserId: u.id, email: u.email, error: err.message },
          'handleRedashUserDetected failed for one user; continuing batch',
        );
      }
    }
  }
}

export const redashProvisioner = new RedashProvisioner();
export default redashProvisioner;
