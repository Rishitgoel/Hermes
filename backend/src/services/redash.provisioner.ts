import {
  PlatformAdapter,
  ProvisionContext,
  ProvisionResult,
  DeprovisionContext,
  PlatformUserStatus,
  OnboardingMessage,
} from './provisioner.interface';
import redashService, { RedashService } from './redash.service';
import prisma from '../config/prisma';
import logger from '../utils/logger';
import config from '../config/config';
import * as templates from '../utils/email-templates';
import {
  notifyUserCreationWorkflow,
  recomputeGroupMemberCounts,
} from './adapter-helpers';

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
 * (via an injected {@link RedashService} instance). All cached state lives in
 * the shared `platform_external_users` / `platform_external_groups` tables,
 * tagged with this adapter's `platform` key — there are no Redash-specific
 * tables anymore, so a second adapter (AWS, Jira) — or a second Redash
 * *instance* (QA) — slots in alongside without schema changes.
 *
 * One `RedashProvisioner` is constructed per registered Redash instance (prod,
 * qa, ...) — see {@link createRedashProvisioner} and provisioning.registry.ts.
 * `platform` is that instance's unique registry key (e.g. "redash" for prod,
 * "redash-qa" for QA); every cache row and DB lookup is tagged with it, so
 * prod and QA never share cache state despite running the same adapter code.
 *
 * Redash IDs are integers on the wire; the generic cache stores `externalId`
 * as a string, so this adapter converts at the boundary (`String(id)` when
 * writing, `parseInt(id, 10)` when calling the Redash API).
 */
export class RedashProvisioner implements PlatformAdapter {
  readonly platform: string;
  readonly displayName: string;
  readonly family: string;
  readonly label?: string;
  private readonly service: RedashService;

  constructor(opts: {
    platform: string;
    displayName: string;
    family: string;
    label?: string;
    service: RedashService;
  }) {
    this.platform = opts.platform;
    this.displayName = opts.displayName;
    this.family = opts.family;
    this.label = opts.label;
    this.service = opts.service;
  }

  // ── Provisioning lifecycle ────────────────────────────────────────────────

  /** Ensure the user exists on Redash, then add them to the target group. */
  async provision(ctx: ProvisionContext): Promise<ProvisionResult> {
    const { id: redashUserId } = await this.service.findOrInviteUser(
      ctx.email,
      ctx.name,
    );
    if (ctx.externalGroupId) {
      await this.service.addUserToGroup(
        redashUserId,
        parseInt(ctx.externalGroupId, 10),
      );
    }
    return { externalUserId: redashUserId.toString() };
  }

  /** Remove the user from the target group on Redash. */
  async deprovision(ctx: DeprovisionContext): Promise<void> {
    if (ctx.externalGroupId) {
      await this.service.removeUserFromGroup(
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
  async createExternalGroup(
    name: string,
  ): Promise<{ externalGroupId: string; name?: string }> {
    const group = await this.service.createGroup(name);
    return { externalGroupId: group.id.toString(), name: group.name };
  }

  /** Delete a backing Redash group by its external id. */
  async deleteExternalGroup(externalGroupId: string): Promise<void> {
    await this.service.deleteGroup(parseInt(externalGroupId, 10));
  }

  // ── Account offboarding ───────────────────────────────────────────────────

  /** Redash's disable is a real, reversible soft-disable — see disableUser. */
  readonly disableUserIsReversible = true;

  /** Disable the user's Redash account (offboarding, not group membership). */
  async disableUser(externalUserId: string): Promise<void> {
    await this.service.disableUser(parseInt(externalUserId, 10));
    // Best-effort cache update for instant UI feedback; the next sync reconfirms
    // from Redash's own is_disabled field regardless.
    await prisma.platformExternalUser
      .updateMany({
        where: { platform: this.platform, externalId: externalUserId },
        data: { isDisabled: true },
      })
      .catch(() => {});
  }

  /** Look up whether a user exists on Redash, using the local cache. */
  async checkUserStatus(
    email: string,
    _userId?: string,
  ): Promise<PlatformUserStatus> {
    const cached = await prisma.platformExternalUser.findUnique({
      where: {
        platform_email: { platform: this.platform, email: email.toLowerCase() },
      },
    });
    return {
      exists: !!cached,
      externalUserId: cached?.externalId,
      email,
    };
  }

  /** Invite a brand-new user to Redash and seed a cache row for them. */
  async inviteUser(email: string, name: string): Promise<ProvisionResult> {
    const { id: redashUserId, inviteLink } =
      await this.service.findOrInviteUser(email, name);
    const externalId = redashUserId.toString();
    await prisma.platformExternalUser.upsert({
      where: { platform_externalId: { platform: this.platform, externalId } },
      update: {
        name,
        email: email.toLowerCase(),
        isPending: true,
        lastSyncedAt: new Date(),
      },
      create: {
        platform: this.platform,
        externalId,
        name,
        email: email.toLowerCase(),
        isDisabled: false,
        isPending: true,
        // No group membership is known yet at invite time — querying Redash's real
        // "default" group id synchronously here would mean an extra API round-trip
        // before the cache is even populated, and the id isn't guaranteed to be the
        // same across instances (prod vs QA may seed differently). Leaving this
        // empty is accurate: a brand-new invited user isn't confirmed to be in any
        // group yet. The next syncUsers() cycle populates the real value from the
        // Redash API's user.groups field — the source of truth.
        externalGroupIds: [],
        lastSyncedAt: new Date(),
      },
    });
    // A fresh invite returns a one-time setup link; an already-existing user
    // returns none. The user-creation flow uses these to pick AWAITING_SETUP vs
    // immediate completion (see provisioner.interface ProvisionResult.metadata).
    return {
      externalUserId: externalId,
      metadata: { inviteLink, alreadyExists: !inviteLink },
    };
  }

  /**
   * Re-issue a fresh Redash invite link for the "resend invite" button. Looks the
   * user up (creating them if somehow absent) and regenerates the one-time link so
   * the stored token always points at the configured Redash instance.
   */
  async regenerateInvite(
    email: string,
    name: string,
  ): Promise<ProvisionResult> {
    const { id: redashUserId } = await this.service.findOrInviteUser(
      email,
      name,
    );
    const inviteLink = await this.service.regenerateInviteLink(redashUserId);
    return {
      externalUserId: redashUserId.toString(),
      metadata: { inviteLink },
    };
  }

  /** The Redash UI users open to run queries / view dashboards. */
  getLaunchUrl(): string | null {
    return this.service.getBaseUrl() || null;
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    try {
      await this.service.syncGroups(); // lightweight probe against the Redash API
      return { healthy: true };
    } catch (err: any) {
      return { healthy: false, message: err.message };
    }
  }

  /** Whether the adapter is returning mock data instead of hitting Redash. */
  isSimulation(): boolean {
    return this.service.getIsSimulation();
  }

  /**
   * Nothing is reserved on Redash. The built-in groups ("default" — every user,
   * "admin" — instance admins) are intentionally imported as ordinary Hermes
   * groups so they show up in the sync; the admin archives them by hand rather
   * than having the reconciler hide them automatically.
   */
  isReservedExternalGroup(_group: {
    externalId: string;
    name: string;
    type?: string | null;
  }): boolean {
    return false;
  }

  /** Onboarding nudge shown once a user's Redash account is fully set up. */
  getOnboardingMessage(): OnboardingMessage {
    return {
      notification: {
        title: 'Account setup complete',
        message:
          'You are now fully set up on Redash. Any group requests already approved by admin have been provisioned.',
        link: '/',
      },
      email: templates.userAccountSetupComplete({
        platformLabel: this.displayName,
      }),
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
    const redashGroups = await this.service.syncGroups();
    logger.info(
      `🔄 RedashProvisioner[${this.platform}]: Fetched ${redashGroups.length} groups from Redash.`,
    );

    // Batch the upserts into chunked transactions instead of one serial
    // round-trip per group (same pattern as the AWS adapter).
    const upserts = redashGroups.map(group => {
      const externalId = group.id.toString();
      return prisma.platformExternalGroup.upsert({
        where: { platform_externalId: { platform: this.platform, externalId } },
        update: { name: group.name, type: group.type, lastSyncedAt: now },
        create: {
          platform: this.platform,
          externalId,
          name: group.name,
          type: group.type,
          lastSyncedAt: now,
        },
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
          platform: this.platform,
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
    const redashUsers = await this.service.syncUsers();
    logger.info(
      `🔄 RedashProvisioner[${this.platform}]: Fetched ${redashUsers.length} users from Redash.`,
    );

    // A user deleted-and-recreated on Redash keeps their email but gets a new
    // numeric id. buildUserUpsert matches by (platform, externalId), so for the
    // recreated user that id isn't found → Prisma inserts a new row → collides
    // with the OLD row's (platform, email) unique constraint (P2002), which
    // aborts the whole upsert transaction and blocks every sync (cron, manual
    // Sync, membership import, Full Resync) until someone cleans it up by hand.
    // Resolve email collisions first: retarget the stale row onto the new id
    // instead of letting the upsert try to insert a duplicate.
    await this.reconcileRecreatedUsers(redashUsers, now);

    // Batch the upserts into chunked transactions instead of awaiting one per
    // user sequentially (O(users) serial DB round-trips on every sync cycle).
    const upserts = redashUsers.map(user => this.buildUserUpsert(user, now));
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
          platform: this.platform,
          externalId: { notIn: activeIds },
          isPending: false,
          lastSyncedAt: { lt: new Date(now.getTime() - PRUNE_GRACE_MS) },
        },
      });
    }

    await recomputeGroupMemberCounts(this.platform);
    await notifyUserCreationWorkflow(
      this.platform,
      redashUsers.map(u => ({
        externalId: u.id.toString(),
        email: u.email,
        name: u.name,
        isPending: u.is_invitation_pending,
        isDisabled: u.is_disabled,
      })),
    );

    return { count: redashUsers.length };
  }

  /**
   * Fast path used by the "I've finished setup — sync now" button: refresh a
   * single user by email instead of pulling the whole directory.
   * Returns false if the user isn't on Redash yet.
   */
  async syncSingleUser(email: string): Promise<boolean> {
    const user = await this.service.fetchUserByEmail(email);
    if (!user) {
      logger.warn(
        { email, platform: this.platform },
        '🔄 RedashProvisioner: User not found in Redash during single sync.',
      );
      return false;
    }
    await this.upsertUserRow(user, new Date());
    if (!user.is_disabled) {
      await notifyUserCreationWorkflow(this.platform, [
        {
          externalId: user.id.toString(),
          email: user.email,
          name: user.name,
          isPending: user.is_invitation_pending,
          isDisabled: user.is_disabled,
        },
      ]);
    }
    return true;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Retarget cache rows for users who were deleted and recreated on Redash
   * (same email, new numeric id) before the upsert-by-externalId batch runs —
   * otherwise the insert for the new id collides with the stale row's
   * (platform, email) unique constraint. One bulk lookup by email, then only
   * issues an update for actual collisions (expected to be rare).
   */
  private async reconcileRecreatedUsers(users: { id: number; email: string }[], now: Date): Promise<void> {
    if (users.length === 0) {
      return;
    }
    const emails = users.map(u => u.email.toLowerCase());
    const existing = await prisma.platformExternalUser.findMany({
      where: { platform: this.platform, email: { in: emails } },
      select: { id: true, email: true, externalId: true },
    });
    const existingByEmail = new Map(existing.map(e => [e.email, e]));

    for (const user of users) {
      const externalId = user.id.toString();
      const email = user.email.toLowerCase();
      const match = existingByEmail.get(email);
      if (match && match.externalId !== externalId) {
        logger.warn(
          `🔄 RedashProvisioner[${this.platform}]: ${email} was recreated on Redash (external id ${match.externalId} → ${externalId}) — retargeting the cache row instead of inserting a duplicate.`,
        );
        await prisma.platformExternalUser.update({
          where: { id: match.id },
          data: { externalId, lastSyncedAt: now },
        });
      }
    }
  }

  /** Build the upsert for one Redash user (not awaited — batched by callers). */
  private buildUserUpsert(
    user: {
      id: number;
      name: string;
      email: string;
      is_disabled: boolean;
      is_invitation_pending: boolean;
      groups: number[];
    },
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
      where: { platform_externalId: { platform: this.platform, externalId } },
      update: row,
      create: { platform: this.platform, externalId, ...row },
    });
  }

  /** Upsert one Redash user into the generic cache (single-user fast path). */
  private async upsertUserRow(
    user: {
      id: number;
      name: string;
      email: string;
      is_disabled: boolean;
      is_invitation_pending: boolean;
      groups: number[];
    },
    now: Date,
  ): Promise<void> {
    await this.buildUserUpsert(user, now);
  }
}

/**
 * Build a {@link RedashProvisioner} for one registered Redash instance.
 * The `displayName` is supplied explicitly from config (e.g. "Redash", "Redash (QA)") or derived from `label`.
 */
export function createRedashProvisioner(instance: {
  key: string;
  family: string;
  label: string;
  displayName?: string;
  service: RedashService;
}): RedashProvisioner {
  const displayName =
    instance.displayName ??
    (instance.label === 'Prod' ? 'Redash' : `Redash (${instance.label})`);
  return new RedashProvisioner({
    platform: instance.key,
    displayName,
    family: instance.family,
    label: instance.label,
    service: instance.service,
  });
}

// Back-compat default export: the prod instance, sourced from config.redash /
// the default redashService. Existing callers (redash-import.service.ts, the
// prod-only maintenance script) keep working unchanged.
export const redashProvisioner = createRedashProvisioner({
  key: 'redash',
  family: 'redash',
  label: 'Prod',
  displayName: 'Redash',
  service: redashService,
});
export default redashProvisioner;
