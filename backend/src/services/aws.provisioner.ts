import {
  PlatformAdapter,
  ProvisionContext,
  ProvisionResult,
  DeprovisionContext,
  PlatformUserStatus,
  OnboardingMessage,
} from './provisioner.interface';
import awsIdentityCenterService, { IdcUser } from './aws-identity-center.service';
import prisma from '../config/prisma';
import logger from '../utils/logger';
import config from '../config/config';
import * as templates from '../utils/email-templates';

/**
 * Platform key this adapter is registered under. The provisioning registry, the
 * cache rows in `platform_external_*`, and `Group.platform` all use this exact
 * lowercase string to route here.
 */
const PLATFORM = 'aws';

/**
 * Don't prune a cache row that was written within this window — Identity Store's
 * ListUsers/ListGroups are eventually consistent, so a user/group created seconds
 * ago may not appear in the very next sync. Pruning it would erase the
 * externalUserId the grant + account-creation flows depend on.
 */
const PRUNE_GRACE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * AWS IAM Identity Center implementation of {@link PlatformAdapter}.
 *
 * Translates the platform-agnostic adapter contract into Identity Store calls via
 * {@link awsIdentityCenterService}. All cached state lives in the shared
 * `platform_external_users` / `platform_external_groups` tables tagged
 * `platform = "aws"` — no AWS-specific tables.
 *
 * Identity model: `externalUserId` is AWS's immutable Identity Store `UserId`
 * (GUID), `externalGroupId` is the Identity Store `GroupId` (GUID). See
 * {@link awsIdentityCenterService} for why this is collision-safe.
 *
 * Self-healing provision: `provision` ensures the Identity Store user exists
 * (creating it if absent) before adding them to the group. This makes the adapter
 * correct even if the account-creation gate is bypassed, and lets the whole flow
 * be exercised in simulation exactly as it behaves live.
 */
export class AwsProvisioner implements PlatformAdapter {
  readonly platform = PLATFORM;
  readonly displayName = 'AWS';

  // ── Provisioning lifecycle ────────────────────────────────────────────────

  /** Ensure the user exists in Identity Center, then add them to the group. */
  async provision(ctx: ProvisionContext): Promise<ProvisionResult> {
    const userId = await this.ensureUser(ctx.email, ctx.name);
    if (ctx.externalGroupId) {
      await awsIdentityCenterService.addUserToGroup(ctx.externalGroupId, userId);
      await this.cacheAddGroup(userId, ctx.email, ctx.name, ctx.externalGroupId);
    }
    return { externalUserId: userId };
  }

  /** Remove the user from the target group on Identity Center. */
  async deprovision(ctx: DeprovisionContext): Promise<void> {
    if (ctx.externalGroupId) {
      await awsIdentityCenterService.removeUserFromGroup(ctx.externalGroupId, ctx.externalUserId);
      await this.cacheRemoveGroup(ctx.externalUserId, ctx.externalGroupId);
    }
  }

  /** Look up whether a user exists, cache-first with a live fallback. */
  async checkUserStatus(email: string): Promise<PlatformUserStatus> {
    const cached = await prisma.platformExternalUser.findUnique({
      where: { platform_email: { platform: PLATFORM, email: email.toLowerCase() } },
    });
    if (cached) {
      return { exists: true, externalUserId: cached.externalId, email };
    }
    // Cache miss → ask Identity Store directly (covers the post-invite window
    // before the next sync populates the cache).
    const userId = await awsIdentityCenterService.getUserIdByEmail(email);
    return { exists: !!userId, externalUserId: userId ?? undefined, email };
  }

  /** Create a brand-new Identity Center user and seed a cache row for them. */
  async inviteUser(email: string, name: string): Promise<ProvisionResult> {
    const { userId } = await awsIdentityCenterService.createUser(email, name);
    await this.upsertUserRow({ userId, email, name, isPending: true });
    return { externalUserId: userId };
  }

  // ── Group lifecycle ───────────────────────────────────────────────────────
  // Lets the admin "add a permission-level" flow provision the backing Identity
  // Center group automatically. Hermes owns the group's existence + membership;
  // the admin wires the group to a permission set + account (the actual access)
  // once in the console — analogous to configuring Redash data-source perms.

  /** Create a backing Identity Center group; returns its GroupId. */
  async createExternalGroup(name: string): Promise<{ externalGroupId: string; name?: string }> {
    const group = await awsIdentityCenterService.createGroup(name);
    return { externalGroupId: group.groupId, name: group.displayName };
  }

  /** Delete a backing Identity Center group by its GroupId. */
  async deleteExternalGroup(externalGroupId: string): Promise<void> {
    await awsIdentityCenterService.deleteGroup(externalGroupId);
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return awsIdentityCenterService.healthCheck();
  }

  /** The AWS SSO access portal users sign in through (null when unconfigured). */
  getLaunchUrl(): string | null {
    return config.aws.accessPortalUrl || null;
  }

  /**
   * Onboarding nudge once an AWS Identity Center user is created. AWS sends no
   * activation email for API-created users, so this is how they learn to set their
   * password via the access portal on first sign-in.
   */
  getOnboardingMessage(): OnboardingMessage {
    const portalUrl = config.aws.accessPortalUrl || '';
    return {
      notification: {
        title: 'AWS account created',
        message: 'Your AWS access is set up. Check your email for sign-in instructions — open the AWS access portal and use "Forgot password" to set your password.',
        link: '/my-requests',
      },
      email: templates.userAwsAccountReady({ portalUrl }),
      dm:
        `🎉 Your AWS access is set up! On first sign-in, open the AWS access portal and use "Forgot password" to set your password` +
        (portalUrl ? `:\n👉 ${portalUrl}` : '.'),
    };
  }

  // ── Sync (cache refresh) ──────────────────────────────────────────────────

  /** Pull all Identity Center groups into the cache, pruning vanished ones. */
  async syncGroups(): Promise<{ count: number }> {
    const now = new Date();
    const groups = await awsIdentityCenterService.listGroups();
    logger.info(`🔄 AwsProvisioner: Fetched ${groups.length} groups from Identity Center.`);

    for (const group of groups) {
      await prisma.platformExternalGroup.upsert({
        where: { platform_externalId: { platform: PLATFORM, externalId: group.groupId } },
        update: { name: group.displayName, type: 'identity-center', lastSyncedAt: now },
        create: {
          platform: PLATFORM,
          externalId: group.groupId,
          name: group.displayName,
          type: 'identity-center',
          metadata: group.description ? { description: group.description } : undefined,
          lastSyncedAt: now,
        },
      });
    }

    // Prune groups that disappeared — but never one written within the grace
    // window (eventual consistency: a just-created group may miss this list).
    // Skip entirely on an empty list: `notIn: []` matches every row, so a transient
    // empty ListGroups response would wipe the whole cache.
    const activeIds = groups.map(g => g.groupId);
    if (activeIds.length > 0) {
      await prisma.platformExternalGroup.deleteMany({
        where: {
          platform: PLATFORM,
          externalId: { notIn: activeIds },
          lastSyncedAt: { lt: new Date(now.getTime() - PRUNE_GRACE_MS) },
        },
      });
    }

    return { count: groups.length };
  }

  /** Pull all Identity Center users into the cache, pruning vanished ones. */
  async syncUsers(): Promise<{ count: number }> {
    const now = new Date();
    const users = await awsIdentityCenterService.listUsers();
    logger.info(`🔄 AwsProvisioner: Fetched ${users.length} users from Identity Center.`);

    // Batch the upserts into chunked transactions instead of awaiting one per user
    // sequentially (O(users) serial DB round-trips on every sync cycle).
    const upserts = users.map((user) =>
      prisma.platformExternalUser.upsert({
        where: { platform_externalId: { platform: PLATFORM, externalId: user.userId } },
        update: {
          name: user.displayName,
          email: user.email.toLowerCase(),
          isDisabled: false,
          isPending: user.isPending,
          externalGroupIds: user.groupIds,
          metadata: { userName: user.userName },
          lastSyncedAt: now,
        },
        create: {
          platform: PLATFORM,
          externalId: user.userId,
          name: user.displayName,
          email: user.email.toLowerCase(),
          isDisabled: false,
          isPending: user.isPending,
          externalGroupIds: user.groupIds,
          metadata: { userName: user.userName },
          lastSyncedAt: now,
        },
      }),
    );
    for (let i = 0; i < upserts.length; i += 100) {
      await prisma.$transaction(upserts.slice(i, i + 100));
    }

    // Prune deleted users — guarded by the grace window AND isPending so a
    // freshly-invited user that hasn't surfaced in ListUsers yet is never erased.
    // Skip entirely on an empty list: `notIn: []` matches every row, so a transient
    // empty ListUsers response would wipe the whole cache.
    const activeIds = users.map(u => u.userId);
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
    await this.notifyUserCreationWorkflow(users);

    return { count: users.length };
  }

  /**
   * Fast path for the "I've finished setup — sync now" button: refresh one user
   * by email and advance any pending account-creation request for them.
   */
  async syncSingleUser(email: string): Promise<boolean> {
    const userId = await awsIdentityCenterService.getUserIdByEmail(email);
    if (!userId) {
      logger.warn({ email }, '🔄 AwsProvisioner: user not found in Identity Center during single sync.');
      return false;
    }
    const user = await awsIdentityCenterService.getUserById(userId);
    if (!user) return false;
    await this.upsertUserRow({
      userId: user.userId,
      email: user.email,
      name: user.displayName,
      isPending: user.isPending,
      groupIds: user.groupIds,
    });
    await this.notifyUserCreationWorkflow([user]);
    return true;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Notify the user-creation workflow about each synced user so any
   * AWAITING_SETUP/APPROVED account-creation request can advance to COMPLETED.
   * Loaded lazily to avoid a static import cycle; per-user try/catch.
   */
  private async notifyUserCreationWorkflow(users: IdcUser[]): Promise<void> {
    // Only users with a tracked account-creation request for this platform can be
    // advanced. Prefetch those emails once so we don't issue a findUnique per synced
    // user (handlePlatformUserDetected would otherwise be an O(users) DB storm).
    const tracked = await prisma.userCreationRequest.findMany({
      where: { platform: PLATFORM },
      select: { userEmail: true },
    });
    if (tracked.length === 0) return;
    const trackedEmails = new Set(tracked.map((r) => r.userEmail.toLowerCase()));

    const { default: userCreationService } = await import('./user-creation.service');
    for (const u of users) {
      if (!trackedEmails.has(u.email.toLowerCase())) continue;
      try {
        await userCreationService.handlePlatformUserDetected(PLATFORM, {
          externalId: u.userId,
          email: u.email,
          name: u.displayName,
          isPending: u.isPending,
        });
      } catch (err: any) {
        logger.error(
          { userId: u.userId, email: u.email, error: err.message },
          'handlePlatformUserDetected (aws) failed for one user; continuing batch',
        );
      }
    }
  }

  /** Resolve the user's immutable id, creating the Identity Store user if absent. */
  private async ensureUser(email: string, name: string): Promise<string> {
    const existing = await awsIdentityCenterService.getUserIdByEmail(email);
    if (existing) return existing;
    logger.info({ email }, '🔄 AwsProvisioner: user absent in Identity Center — creating on provision');
    const { userId } = await awsIdentityCenterService.createUser(email, name);
    return userId;
  }

  /** Upsert a single user cache row. Refreshes group memberships when provided. */
  private async upsertUserRow(u: {
    userId: string;
    email: string;
    name: string;
    isPending: boolean;
    groupIds?: string[];
  }): Promise<void> {
    const now = new Date();
    const base = {
      name: u.name,
      email: u.email.toLowerCase(),
      isDisabled: false,
      isPending: u.isPending,
      metadata: { userName: u.email.toLowerCase() },
      lastSyncedAt: now,
    };
    // Only overwrite externalGroupIds when we actually know the memberships
    // (sync paths). On invite we don't, so we preserve whatever's cached.
    const update = u.groupIds ? { ...base, externalGroupIds: u.groupIds } : base;
    await prisma.platformExternalUser.upsert({
      where: { platform_externalId: { platform: PLATFORM, externalId: u.userId } },
      update,
      create: {
        platform: PLATFORM,
        externalId: u.userId,
        externalGroupIds: u.groupIds ?? [],
        ...base,
      },
    });
  }

  /** Add a groupId to a user's cached membership list (idempotent). */
  private async cacheAddGroup(userId: string, email: string, name: string, groupId: string): Promise<void> {
    const existing = await prisma.platformExternalUser.findUnique({
      where: { platform_externalId: { platform: PLATFORM, externalId: userId } },
    });
    if (!existing) {
      await this.upsertUserRow({ userId, email, name, isPending: false, groupIds: [groupId] });
      return;
    }
    if (existing.externalGroupIds.includes(groupId)) return;
    // Atomic append (array_append) rather than read-modify-write of the whole array,
    // so a concurrent cache write for a different group isn't clobbered.
    await prisma.platformExternalUser.update({
      where: { id: existing.id },
      data: { externalGroupIds: { push: groupId }, lastSyncedAt: new Date() },
    });
  }

  /** Remove a groupId from a user's cached membership list (best-effort). */
  private async cacheRemoveGroup(userId: string, groupId: string): Promise<void> {
    // Atomic array_remove rather than read-filter-write, so a concurrent cache write
    // for a different group isn't clobbered. No-op if the row/group isn't present.
    await prisma.$executeRaw`
      UPDATE platform_external_users
      SET external_group_ids = array_remove(external_group_ids, ${groupId}),
          last_synced_at = NOW()
      WHERE platform = ${PLATFORM} AND external_id = ${userId}
    `;
  }

  /** Recompute and persist member counts for every cached AWS group. */
  private async recomputeGroupMemberCounts(): Promise<void> {
    const [groups, users] = await Promise.all([
      prisma.platformExternalGroup.findMany({ where: { platform: PLATFORM }, select: { id: true, externalId: true } }),
      prisma.platformExternalUser.findMany({ where: { platform: PLATFORM }, select: { externalGroupIds: true } }),
    ]);
    // Tally members per group in a single pass over users instead of an
    // O(groups × users) nested scan.
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
}

export const awsProvisioner = new AwsProvisioner();
export default awsProvisioner;
