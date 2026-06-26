import {
  PlatformAdapter,
  ProvisionContext,
  ProvisionResult,
  DeprovisionContext,
  PlatformUserStatus,
  OnboardingMessage,
} from './provisioner.interface';
import redashService from './redash.service';
import prisma from '../config/prisma';
import logger from '../utils/logger';
import config from '../config/config';
import * as templates from '../utils/email-templates';

/**
 * Platform key this adapter is registered under. The provisioning registry,
 * the cache rows in `platform_external_*`, and `Group.platform` all use this
 * exact lowercase string to route to this adapter.
 */
const PLATFORM = 'redash';

/**
 * Don't prune a cache row that was written within this window. A user invited
 * moments ago (whose row `inviteUser` just seeded) may not appear in a full
 * Redash fetch that started before the invite landed — pruning the row would
 * erase the externalUserId the account-creation flow depends on. Same guard
 * the AWS adapter uses.
 */
const PRUNE_GRACE_MS = 10 * 60 * 1000; // 10 minutes

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
  readonly displayName = 'Redash';

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

  // ── Group lifecycle ───────────────────────────────────────────────────────
  // Lets the admin "add a permission-level" flow provision the backing Redash
  // group automatically. Hermes owns the group's existence + membership; the
  // admin configures its data-source permissions (read-only vs write) in Redash.

  /** Create a backing Redash group; returns its id as a string. */
  async createExternalGroup(name: string): Promise<{ externalGroupId: string; name?: string }> {
    const group = await redashService.createGroup(name);
    return { externalGroupId: group.id.toString(), name: group.name };
  }

  /** Delete a backing Redash group by its external id. */
  async deleteExternalGroup(externalGroupId: string): Promise<void> {
    await redashService.deleteGroup(parseInt(externalGroupId, 10));
  }

  /** Look up whether a user exists on Redash, using the local cache. */
  async checkUserStatus(email: string, _userId?: string): Promise<PlatformUserStatus> {
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
    const { id: redashUserId, inviteLink } = await redashService.findOrInviteUser(email, name);
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
    // A fresh invite returns a one-time setup link; an already-existing user
    // returns none. The user-creation flow uses these to pick AWAITING_SETUP vs
    // immediate completion (see provisioner.interface ProvisionResult.metadata).
    return { externalUserId: externalId, metadata: { inviteLink, alreadyExists: !inviteLink } };
  }

  /**
   * Re-issue a fresh Redash invite link for the "resend invite" button. Looks the
   * user up (creating them if somehow absent) and regenerates the one-time link so
   * the stored token always points at the configured Redash instance.
   */
  async regenerateInvite(email: string, name: string): Promise<ProvisionResult> {
    const { id: redashUserId } = await redashService.findOrInviteUser(email, name);
    const inviteLink = await redashService.regenerateInviteLink(redashUserId);
    return { externalUserId: redashUserId.toString(), metadata: { inviteLink } };
  }

  /** The Redash UI users open to run queries / view dashboards. */
  getLaunchUrl(): string | null {
    return config.redash.baseUrl || null;
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    try {
      await redashService.syncGroups(); // lightweight probe against the Redash API
      return { healthy: true };
    } catch (err: any) {
      return { healthy: false, message: err.message };
    }
  }

  /** Whether the adapter is returning mock data instead of hitting Redash. */
  isSimulation(): boolean {
    return config.redash.isSimulation;
  }

  /**
   * Nothing is reserved on Redash. The built-in groups ("default" — every user,
   * "admin" — instance admins) are intentionally imported as ordinary Hermes
   * groups so they show up in the sync; the admin archives them by hand rather
   * than having the reconciler hide them automatically.
   */
  isReservedExternalGroup(_group: { externalId: string; name: string; type?: string | null }): boolean {
    return false;
  }

  /** Onboarding nudge shown once a user's Redash account is fully set up. */
  getOnboardingMessage(): OnboardingMessage {
    return {
      notification: {
        title: 'Account setup complete',
        message: 'You are now fully set up on Redash. Any group requests already approved by admin have been provisioned.',
        link: '/',
      },
      email: templates.userAccountSetupComplete({ platformLabel: this.displayName }),
      dm: `🎉 You've finished ${this.displayName} setup — your Hermes account is fully active and any approved group memberships have been provisioned.\n👉 ${config.frontend.url}/`,
    };
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

    // Batch the upserts into chunked transactions instead of one serial
    // round-trip per group (same pattern as the AWS adapter).
    const upserts = redashGroups.map((group) => {
      const externalId = group.id.toString();
      return prisma.platformExternalGroup.upsert({
        where: { platform_externalId: { platform: PLATFORM, externalId } },
        update: { name: group.name, type: group.type, lastSyncedAt: now },
        create: { platform: PLATFORM, externalId, name: group.name, type: group.type, lastSyncedAt: now },
      });
    });
    for (let i = 0; i < upserts.length; i += 100) {
      await prisma.$transaction(upserts.slice(i, i + 100));
    }

    // Drop groups that no longer exist on Redash — but never one written within
    // the grace window (a group created moments ago may miss this fetch). Skip on
    // an empty list: `notIn: []` matches every row, so a transient empty fetch
    // would wipe the whole cache.
    const activeIds = redashGroups.map(g => g.id.toString());
    if (activeIds.length > 0) {
      await prisma.platformExternalGroup.deleteMany({
        where: {
          platform: PLATFORM,
          externalId: { notIn: activeIds },
          lastSyncedAt: { lt: new Date(now.getTime() - PRUNE_GRACE_MS) },
        },
      });
    }

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

    // Batch the upserts into chunked transactions instead of awaiting one per
    // user sequentially (O(users) serial DB round-trips on every sync cycle).
    const upserts = redashUsers.map((user) => this.buildUserUpsert(user, now));
    for (let i = 0; i < upserts.length; i += 100) {
      await prisma.$transaction(upserts.slice(i, i + 100));
    }

    // Remove users that no longer exist on Redash — guarded by the grace window
    // AND isPending, so a freshly-invited user whose seeded cache row hasn't
    // surfaced in a full fetch yet is never erased. Skip on an empty list:
    // `notIn: []` matches every row, so a transient empty fetch would wipe the cache.
    const activeIds = redashUsers.map(u => u.id.toString());
    if (activeIds.length > 0) {
      await prisma.platformExternalUser.deleteMany({
        where: {
          platform: PLATFORM,
          externalId: { notIn: activeIds },
          isPending: false,
          lastSyncedAt: { lt: new Date(now.getTime() - PRUNE_GRACE_MS) },
        },
      });
    }

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

  /** Build the upsert for one Redash user (not awaited — batched by callers). */
  private buildUserUpsert(
    user: { id: number; name: string; email: string; is_disabled: boolean; is_invitation_pending: boolean; groups: number[] },
    now: Date,
  ) {
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
    return prisma.platformExternalUser.upsert({
      where: { platform_externalId: { platform: PLATFORM, externalId } },
      update: row,
      create: { platform: PLATFORM, externalId, ...row },
    });
  }

  /** Upsert one Redash user into the generic cache (single-user fast path). */
  private async upsertUserRow(
    user: { id: number; name: string; email: string; is_disabled: boolean; is_invitation_pending: boolean; groups: number[] },
    now: Date,
  ): Promise<void> {
    await this.buildUserUpsert(user, now);
  }

  /** Recompute and persist member counts for every cached Redash group. */
  private async recomputeGroupMemberCounts(): Promise<void> {
    const [groups, users] = await Promise.all([
      prisma.platformExternalGroup.findMany({ where: { platform: PLATFORM }, select: { id: true, externalId: true } }),
      prisma.platformExternalUser.findMany({ where: { platform: PLATFORM }, select: { externalGroupIds: true } }),
    ]);
    // Tally members per group in a single pass over users instead of an
    // O(groups × users) nested scan (same pattern as the AWS adapter).
    const counts = new Map<string, number>();
    for (const u of users) {
      for (const gid of u.externalGroupIds) {
        counts.set(gid, (counts.get(gid) ?? 0) + 1);
      }
    }
    const updates = groups.map(group =>
      prisma.platformExternalGroup.update({
        where: { id: group.id },
        data: { memberCount: counts.get(group.externalId) ?? 0 },
      }),
    );
    if (updates.length) await prisma.$transaction(updates);
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
    // Only users with a tracked account-creation request for this platform can be
    // advanced. Prefetch those emails once so we don't issue a findUnique per
    // synced user (an O(users) DB storm on every sync — same guard as AWS).
    const tracked = await prisma.userCreationRequest.findMany({
      where: { platform: PLATFORM },
      select: { userEmail: true },
    });
    if (tracked.length === 0) return;
    const trackedEmails = new Set(tracked.map((r) => r.userEmail.toLowerCase()));

    const { default: userCreationService } = await import('./user-creation.service');
    for (const u of users) {
      if (u.is_disabled) continue;
      if (!trackedEmails.has(u.email.toLowerCase())) continue;
      try {
        await userCreationService.handlePlatformUserDetected(PLATFORM, {
          externalId: u.id.toString(),
          email: u.email,
          name: u.name,
          isPending: u.is_invitation_pending,
        });
      } catch (err: any) {
        logger.error(
          { redashUserId: u.id, email: u.email, error: err.message },
          'handlePlatformUserDetected failed for one user; continuing batch',
        );
      }
    }
  }
}

export const redashProvisioner = new RedashProvisioner();
export default redashProvisioner;
