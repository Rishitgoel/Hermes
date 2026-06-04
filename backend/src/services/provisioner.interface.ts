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
  metadata?: Record<string, unknown>;
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

  /** Add an existing user to a group on the platform. */
  provision(ctx: ProvisionContext): Promise<ProvisionResult>;
  /** Remove a user from a group on the platform. */
  deprovision(ctx: DeprovisionContext): Promise<void>;

  /** Look a user up by email — used to decide whether an invite is needed. */
  checkUserStatus(email: string): Promise<PlatformUserStatus>;
  /** Create the user's account on the platform (typically sends an invite). */
  inviteUser(email: string, name: string): Promise<ProvisionResult>;

  /** Optional: refresh the cached user list for this platform. */
  syncUsers?(): Promise<{ count: number }>;
  /** Optional: refresh the cached group list for this platform. */
  syncGroups?(): Promise<{ count: number }>;

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

  /** Liveness probe surfaced on the `/health` endpoint. */
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
}

// Keep backward-compat alias
export type Provisioner = PlatformAdapter;
