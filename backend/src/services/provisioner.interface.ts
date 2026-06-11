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
  metadata?: Record<string, unknown>;
}

/** Result of looking a user up on the platform by email. */
export interface PlatformUserStatus {
  exists: boolean;
  externalUserId?: string;
  email: string;
  metadata?: Record<string, unknown>;
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

  /** Add an existing user to a group on the platform. */
  provision(ctx: ProvisionContext): Promise<ProvisionResult>;
  /** Remove a user from a group on the platform. */
  deprovision(ctx: DeprovisionContext): Promise<void>;

  /** Look a user up by email — used to decide whether an invite is needed. */
  checkUserStatus(email: string): Promise<PlatformUserStatus>;
  /** Create the user's account on the platform (typically sends an invite). */
  inviteUser(email: string, name: string): Promise<ProvisionResult>;

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
   * Optional: whether this adapter is currently running against a mock/simulated
   * backend instead of the real platform. SyncService uses this to skip the
   * Hermes-group reconciliation in simulation mode (so local dev seed data isn't
   * archived/replaced to match the in-process mock store) — same live-only rule
   * the admin reconciliation follows. Adapters that omit it are treated as live.
   */
  isSimulation?(): boolean;

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
   */
  getOnboardingMessage?(): OnboardingMessage;
}

// Keep backward-compat alias
export type Provisioner = PlatformAdapter;
