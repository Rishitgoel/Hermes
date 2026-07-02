/**
 * Platform-provisioning contract.
 *
 * Every integration Hermes can grant access to (Redash today; AWS / Jira next)
 * is represented by a single object that implements {@link PlatformAdapter} and
 * is registered in the {@link ../services/provisioning.registry ProvisioningRegistry}.
 * The access-workflow service never talks to a platform directly — it looks the
 * adapter up by `Group.platform` and calls these methods. To add a platform you
 * implement this interface and register it; no workflow/sync/scheduler changes.
 */

import type { EmailContent } from '../utils/email-templates';

/** Inputs needed to grant a user access to a single group on the target platform. */
export interface ProvisionContext {
  email: string;
  name: string;
  /**
   * Hermes user id of the requester (stable across sessions). The access-creation
   * gate keys on `(userId, platform)`, so an adapter that mints its own per-user
   * credential (ZooKeeper) should resolve it by `userId` too — resolving by `email`
   * instead breaks when the Keycloak JWT carries no/different email between account
   * approval and group request, making the gate say "approved" while provisioning
   * claims the account doesn't exist. Optional for back-compat; email-based adapters
   * (Redash/AWS resolve the user on the platform itself) ignore it.
   */
  userId?: string;
  /** ID of the group on the target platform the user should be added to. */
  externalGroupId?: string;
  /** Platform-specific extras (AWS ARNs, Jira project keys, etc.). */
  metadata?: Record<string, unknown>;
}

/** Identifies the user on the platform after a successful provision/invite. */
export interface ProvisionResult {
  externalUserId: string;
  /**
   * Platform-specific extras. For {@link PlatformAdapter.inviteUser} the
   * user-creation flow understands two optional keys:
   *  - `inviteLink?: string` — a one-time setup URL the user must visit to finish
   *    signup (Redash issues one). When present, the account-creation request goes
   *    to AWAITING_SETUP and waits for sync to confirm completion.
   *  - `alreadyExists?: boolean` — the account already existed (no setup needed),
   *    so the request can complete immediately.
   * A platform that creates a ready-to-use account (AWS Identity Center) returns
   * neither, and the request completes right away.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Onboarding nudge shown to a user once their account on a platform is COMPLETED.
 * Each adapter owns its own copy (Redash: "you're set up"; AWS: "set your password
 * via the access portal") so the notification layer stays platform-agnostic.
 */
export interface OnboardingMessage {
  /** In-app notification. */
  notification: { title: string; message: string; link?: string };
  /** Rendered email to send the user. */
  email: EmailContent;
  /** Slack/DM text. */
  dm: string;
}

/** Inputs needed to revoke a user's access to a single group on the platform. */
export interface DeprovisionContext {
  externalUserId: string;
  externalGroupId?: string;
  /**
   * Optional: when a level swap deprovisions the OLD mapping right after provisioning
   * the NEW one, this carries the NEW mapping so a multi-target adapter (ZooKeeper,
   * whose externalGroupId is a list of znode paths) does NOT strip a target the new
   * mapping still grants — i.e. shared paths between two levels survive the swap.
   * Single-target adapters (Redash/AWS) ignore it.
   */
  retainExternalGroupId?: string;
  metadata?: Record<string, unknown>;
}

/** Result of looking a user up on the platform by email. */
export interface PlatformUserStatus {
  exists: boolean;
  externalUserId?: string;
  email: string;
  metadata?: Record<string, unknown>;
}

/** A group's active members, handed to {@link PlatformAdapter.reconcileMembers}. */
export interface ReconcileMembersContext {
  /** The group/level's external id before the admin's edit (null if it had none). */
  oldExternalGroupId: string | null;
  /** The external id after the edit (null if cleared). */
  newExternalGroupId: string | null;
  /**
   * Active members of the group/level to bring in line with the new mapping.
   * `retainExternalGroupIds` carries the external ids of each member's OTHER active
   * grants on this platform, so a multi-target adapter (ZooKeeper) never strips a target
   * the member still legitimately holds through a different group/level. Single-target
   * adapters ignore it.
   */
  members: { email: string; name: string; externalUserId: string; retainExternalGroupIds?: string[] }[];
}

/**
 * Summary of a {@link PlatformAdapter.reconcileMembers} run, surfaced to the admin
 * (and audited). For ZooKeeper the paths are znode paths; `errors` carries any
 * per-member ACL failures that need manual cleanup.
 */
export interface ReconcileMembersResult {
  /** Targets newly added to the mapping (granted to every member). */
  addedPaths: string[];
  /** Targets removed from the mapping (stripped from every member). */
  removedPaths: string[];
  /** Targets kept but with changed permissions (re-applied to every member). */
  updatedPaths: string[];
  /** How many members were reconciled. */
  memberCount: number;
  /** Per-member/target failures (best-effort: the config change still committed). */
  errors: { member: string; error: string }[];
}

/**
 * The single integration surface a platform adapter must satisfy.
 *
 * Lifecycle order for a typical access grant:
 *   1. {@link inviteUser} — create the account if the user has never existed on
 *      the platform (drives Hermes' user-creation flow).
 *   2. {@link provision} — add the (now-existing) user to a specific group.
 *   3. {@link deprovision} — remove the user from a group when access is
 *      revoked or expires.
 *
 * {@link syncUsers}/{@link syncGroups} are optional: implement them to keep
 * Hermes' local cache (`platform_external_users` / `platform_external_groups`)
 * in step with the platform. The orchestrating SyncService skips adapters that
 * don't provide them.
 */
export interface PlatformAdapter {
  /** Stable key matching `Group.platform` and the registry key (e.g. "redash"). */
  readonly platform: string;

  /**
   * Human-friendly platform name for user-facing copy (e.g. "Redash", "AWS").
   * The notification layer reads this instead of branching on the platform key,
   * so a new adapter's name flows into emails/DMs/notifications automatically.
   */
  readonly displayName: string;

  /**
   * Optional: UI-grouping key for a platform that has multiple registered
   * instances (e.g. both `redash` and `redash-qa` set `family = "redash"`).
   * The frontend collapses every adapter that shares a family into one
   * platform card with an instance chooser. Adapters that omit this default
   * to grouping by their own `platform` key (i.e. they render as a single,
   * ungrouped card) — so a single-instance platform (AWS, ZooKeeper) needs
   * no change to stay that way.
   */
  readonly family?: string;

  /**
   * Optional: human label distinguishing this instance within its `family`
   * (e.g. "Prod", "QA"). Only meaningful alongside `family`; omit for a
   * single-instance platform.
   */
  readonly label?: string;

  /** Add an existing user to a group on the platform. */
  provision(ctx: ProvisionContext): Promise<ProvisionResult>;
  /** Remove a user from a group on the platform. */
  deprovision(ctx: DeprovisionContext): Promise<void>;

  /** Look a user up by email — used to decide whether an invite is needed. */
  checkUserStatus(email: string, userId?: string): Promise<PlatformUserStatus>;
  /**
   * Create the user's account on the platform (typically sends an invite). The optional
   * `userId` is the Hermes user id from the account-creation request; adapters whose
   * cache key can't rely on email (ZooKeeper — a live Keycloak JWT often carries no email,
   * so many users share the empty string) use it to key per-user state on a stable id.
   * Email-keyed adapters (Redash/AWS) ignore it.
   */
  inviteUser(email: string, name: string, userId?: string): Promise<ProvisionResult>;

  /**
   * Optional: re-issue a one-time setup link for a user whose account already
   * exists but hasn't finished setup (the "resend invite" button). Only platforms
   * whose invite IS a regenerable link (Redash) implement this; the user-creation
   * flow detects its absence and, for link-less platforms (AWS), falls back to
   * retrying a failed `inviteUser` instead. Returns the (possibly unchanged)
   * external id plus a fresh `inviteLink` in `metadata`.
   */
  regenerateInvite?(email: string, name: string): Promise<ProvisionResult>;

  /** Optional: refresh the cached user list for this platform. */
  syncUsers?(): Promise<{ count: number }>;
  /** Optional: refresh the cached group list for this platform. */
  syncGroups?(): Promise<{ count: number }>;
  /**
   * Optional: refresh a single user by email (the "I've finished setup — sync now"
   * fast-path). Returns true if the user now exists on the platform. Adapters that
   * back the user-creation flow should also advance any AWAITING_SETUP request via
   * `userCreationService.handlePlatformUserDetected`.
   */
  syncSingleUser?(email: string): Promise<boolean>;

  /**
   * Optional: create a backing group on the platform and return its external id.
   * Used by the admin "add a permission-level" flow so Hermes provisions the
   * level's backing group itself (instead of an admin pasting the id of a
   * pre-existing one). The admin then configures that group's permissions
   * (e.g. read-only vs write data-source access) on the platform directly.
   * Adapters that can't create groups simply omit this.
   */
  createExternalGroup?(name: string): Promise<{ externalGroupId: string; name?: string }>;
  /** Optional: delete a backing group on the platform by its external id. */
  deleteExternalGroup?(externalGroupId: string): Promise<void>;

  /**
   * Optional: after an admin edits a group's/level's `externalGroupId`, bring the
   * group's EXISTING active members in line with the new mapping. Only meaningful for
   * an adapter whose `externalGroupId` encodes more than one immutable target —
   * ZooKeeper's is a newline-separated list of znode paths, so adding a path must
   * grant it to current members and removing one must strip it.
   *
   * Implementing this hook is what opts an adapter's `externalGroupId` into being
   * *editable*: the admin layer allows the edit only when the platform can reconcile.
   * Single-group platforms (Redash/AWS) omit it and keep their `externalGroupId`
   * immutable, since swapping it would orphan members rather than re-map them.
   *
   * Best-effort: the Hermes-side config has already been saved as the source of truth,
   * so per-member failures are returned (not thrown) for auditing/manual cleanup.
   */
  reconcileMembers?(ctx: ReconcileMembersContext): Promise<ReconcileMembersResult>;

  /**
   * Optional: validate a candidate `externalGroupId` for this platform's id format
   * BEFORE it is persisted (e.g. ZooKeeper checks every line parses to a znode path).
   * Throws a ValidationError on a malformed value, so the admin layer can reject the
   * edit/create rather than saving a broken mapping that later fails every provision.
   * Adapters whose id is an opaque string (Redash/AWS) omit it.
   */
  validateExternalGroupId?(externalGroupId: string): void;

  /**
   * Optional: whether this adapter is currently running against a mock/simulated
   * backend instead of the real platform. SyncService uses this to skip the
   * Hermes-group reconciliation in simulation mode (so local dev seed data isn't
   * archived/replaced to match the in-process mock store) — same live-only rule
   * the admin reconciliation follows. Adapters that omit it are treated as live.
   */
  isSimulation?(): boolean;

  /**
   * Optional: whether this platform is currently administratively enabled. AWS is
   * the only adapter that can be toggled off (config.aws.isEnabled, driven by
   * AWS_ENABLED via scripts/toggle-aws.ts) without being unregistered — a disabled
   * platform must still resolve via the registry (existing grants/history reference
   * it) but should be hidden from sync, admin-manageable-platform lists, and
   * platform-admin reconciliation. Adapters that omit this are treated as always
   * enabled (undefined ⇒ enabled) — only an adapter with a real on/off switch needs
   * to implement it.
   */
  isEnabled?(): boolean;

  /**
   * Optional: marks a platform group that must NEVER surface as a requestable
   * Hermes group — e.g. AWS's API-TESTING group (it carries the service user's
   * own admin permissions) or Redash's built-in default/admin groups. The
   * Hermes-group reconciliation skips creating these and archives any active
   * Hermes group that points at one. It does NOT delete anything on the platform.
   */
  isReservedExternalGroup?(group: { externalId: string; name: string; type?: string | null }): boolean;

  /** Liveness probe surfaced on the `/health` endpoint. */
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;

  /**
   * Optional: the URL a user opens to actually use this platform (Redash base
   * URL, AWS SSO access portal, …). Surfaced by `GET /api/platforms` so the UI can
   * render a per-grant "open" link without knowing platform specifics. Return null
   * when no launch URL is configured (the UI then omits the link).
   */
  getLaunchUrl?(): string | null;

  /**
   * Optional: the onboarding nudge shown to a user once their account on this
   * platform is COMPLETED. Adapters that need platform-specific first-sign-in copy
   * (Redash setup-done, AWS set-your-password) implement it; the notification
   * service falls back to a generic message for adapters that don't.
   *
   * `details` carries optional per-completion data from {@link inviteUser}'s
   * `ProvisionResult.metadata` (threaded through the completion event). A platform
   * that is its own identity issuer (ZooKeeper mints a digest credential) uses it to
   * deliver the one-time secret over email/DM. Adapters that don't need it ignore it.
   */
  getOnboardingMessage?(details?: Record<string, unknown>): OnboardingMessage;
}

// Keep backward-compat alias
export type Provisioner = PlatformAdapter;
