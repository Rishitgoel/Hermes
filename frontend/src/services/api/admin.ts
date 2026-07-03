import apiClient from '../apiClient';

/**
 * Admin Management API (three-tier: super → platform → group).
 * All endpoints live under /api/admin and are authorized server-side by tier.
 */

export interface AdminUser {
  userId: string;
  userName: string;
  userEmail: string;
  status: string;
}

export interface PlatformAdminRow {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  platform: string;
  assignedAt: string;
  assignedBy: string;
}

export interface GroupAdminRow {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  groupId: string;
  assignedAt: string;
  assignedBy: string;
  group: { name: string; slug: string; platform: string; color: string | null };
}

export interface ManageableGroup {
  id: string;
  name: string;
  slug: string;
  platform: string;
  description: string;
  color: string | null;
  icon: string | null;
  tables: string[];
  externalGroupId: string | null;
  isActive: boolean;
  memberCount: number;
  adminCount: number;
}

/** The raw Group row returned by create/update (no member/admin counts). */
export interface GroupRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  platform: string;
  icon: string | null;
  color: string | null;
  externalGroupId: string | null;
  tables: string[];
  isActive: boolean;
}

export interface CreateGroupInput {
  name: string;
  slug: string;
  description?: string;
  platform: string;
  icon?: string;
  color?: string;
  tables?: string[];
  externalGroupId?: string;
}

/**
 * Editable subset — slug/platform are immutable after creation. externalGroupId is
 * editable only for platforms whose adapter reconciles existing members (ZooKeeper's
 * newline-separated path list); the backend rejects it for single-group platforms.
 */
export interface UpdateGroupInput {
  name?: string;
  description?: string;
  icon?: string | null;
  color?: string | null;
  tables?: string[];
  externalGroupId?: string;
  isActive?: boolean;
}

/**
 * Summary returned by the backend when an edit to a group's/level's externalGroupId
 * reconciles existing members (ZooKeeper). null when nothing was reconciled.
 */
export interface ReconciliationSummary {
  addedPaths: string[];
  removedPaths: string[];
  updatedPaths: string[];
  memberCount: number;
  errors: { member: string; error: string }[];
}

export interface DeleteGroupResult {
  id: string;
  deleted: boolean; // true = hard-deleted; false = archived (group had history)
  requestCount?: number;
  accessCount?: number;
}

export interface UserAccessRow {
  id: string; // userAccessId
  groupId: string;
  groupName: string;
  groupSlug: string;
  groupColor: string | null;
  groupIcon: string | null;
  platform: string;
  levelId: string | null;
  levelName: string | null;
  levelPermission: string | null;
  externalUserId: string | null;
  grantedAt: string;
  expiresAt: string | null;
  grantedBy: string;
}

export interface RevokeUserAccessResult {
  revoked: string[]; // userAccessIds successfully revoked
  failed: { id: string; groupName: string; error: string }[];
}

/** A platform ACCOUNT the user holds (not group membership — that's UserAccessRow). */
export interface UserPlatformAccountRow {
  platform: string;
  status: 'APPROVED' | 'AWAITING_SETUP' | 'COMPLETED';
  externalUserId: string | null;
  // Whether this platform's adapter implements account-level disable at all
  // (ZooKeeper doesn't — it has no account concept; offboarding there is
  // achieved by revoking access grants alone).
  supportsDisable: boolean;
  // true = a soft, reversible disable (Redash); false = a permanent delete (AWS).
  // Only meaningful when supportsDisable is true.
  disableIsReversible: boolean;
  isDisabled: boolean;
  // Active UserAccess grants this user still holds on this platform. Disabling
  // the account never implicitly touches these for a reversible disable (Redash
  // keeps group membership) — but an irreversible delete (AWS) auto-revokes them
  // (see DisableUserAccountsResult.disabled[].grantsRevoked), since a deleted
  // account can never again validly back an active grant.
  activeGrantCount: number;
}

export interface DisableUserAccountsResult {
  disabled: { platform: string; reversible: boolean; grantsRevoked: string[] }[];
  failed: { platform: string; error: string }[];
  unsupported: string[];
}

export interface GroupMember {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  groupId: string;
  externalUserId: string | null;
  isActive: boolean;
  grantedAt: string;
  expiresAt: string | null;
  grantedBy: string;
  // The level the member currently holds (null = level-less/legacy grant).
  levelId: string | null;
  levelName: string | null;
  levelPermission: string | null;
  // True if this member also holds the group-admin role (independent of the grant).
  isAdmin: boolean;
}

// ── Lookups ─────────────────────────────────────────────────────────────────

export async function listManageablePlatforms(): Promise<string[]> {
  const res = await apiClient.get('/api/admin/platforms');
  return res.data as string[];
}

export async function searchUsers(search: string): Promise<AdminUser[]> {
  const res = await apiClient.get('/api/admin/users', { params: { search } });
  return res.data as AdminUser[];
}

export async function listManageableGroups(platform?: string): Promise<ManageableGroup[]> {
  const res = await apiClient.get('/api/admin/groups', { params: platform ? { platform } : {} });
  return res.data as ManageableGroup[];
}

// ── User access (cross-platform audit + bulk revoke) ───────────────────────

export async function listUserAccess(userId: string): Promise<UserAccessRow[]> {
  const res = await apiClient.get('/api/admin/user-access', { params: { userId } });
  return res.data as UserAccessRow[];
}

/** userAccessIds omitted = revoke every active grant the caller can see for this user. */
export async function revokeUserAccess(
  userId: string,
  opts?: { userAccessIds?: string[]; reason?: string },
): Promise<RevokeUserAccessResult> {
  const res = await apiClient.post('/api/admin/user-access/revoke', { userId, ...opts });
  return res.data as RevokeUserAccessResult;
}

// ── Offboarding: disable/delete the platform ACCOUNT itself ────────────────
// Separate from access grants above — a revoked grant still leaves the person's
// account (and ability to sign in) on the platform. See CLAUDE.md's Offboarding
// section: Redash disables (reversible), AWS permanently deletes, ZooKeeper has
// no account concept (reports as `unsupported`, not a failure).

export async function listUserPlatformAccounts(userId: string): Promise<UserPlatformAccountRow[]> {
  const res = await apiClient.get('/api/admin/user-platform-accounts', { params: { userId } });
  return res.data as UserPlatformAccountRow[];
}

/** platforms omitted = disable every eligible account the caller can see for this user. */
export async function disableUserAccounts(
  userId: string,
  opts?: { platforms?: string[]; reason?: string },
): Promise<DisableUserAccountsResult> {
  const res = await apiClient.post('/api/admin/user-access/disable-accounts', { userId, ...opts });
  return res.data as DisableUserAccountsResult;
}

// ── Group CRUD (super or platform admin of the group's platform) ──────────────

export async function createGroup(body: CreateGroupInput): Promise<GroupRecord> {
  const res = await apiClient.post('/api/admin/groups', body);
  return res.data as GroupRecord;
}

export async function updateGroup(
  groupId: string,
  body: UpdateGroupInput,
): Promise<GroupRecord & { reconciliation?: ReconciliationSummary | null }> {
  const res = await apiClient.put(`/api/admin/groups/${groupId}`, body);
  return res.data as GroupRecord & { reconciliation?: ReconciliationSummary | null };
}

// force=false: delete only if the group has no history, else archive (default).
// force=true: permanently delete the group + its history — backend rejects this
// if the group still has active members.
export async function deleteGroup(groupId: string, force = false): Promise<DeleteGroupResult> {
  const res = await apiClient.delete(`/api/admin/groups/${groupId}`, force ? { params: { force: 'true' } } : undefined);
  return res.data as DeleteGroupResult;
}

// ── Platform admins ──────────────────────────────────────────────────────────

export async function listPlatformAdmins(platform?: string): Promise<PlatformAdminRow[]> {
  const res = await apiClient.get('/api/admin/platform-admins', { params: platform ? { platform } : {} });
  return res.data as PlatformAdminRow[];
}

export async function assignPlatformAdmin(userId: string, platform: string): Promise<PlatformAdminRow> {
  const res = await apiClient.post('/api/admin/platform-admins', { userId, platform });
  return res.data as PlatformAdminRow;
}

export async function removePlatformAdmin(id: string): Promise<void> {
  await apiClient.delete(`/api/admin/platform-admins/${id}`);
}

// ── Group admins ──────────────────────────────────────────────────────────────

export async function listGroupAdmins(params: { platform?: string; groupId?: string }): Promise<GroupAdminRow[]> {
  const res = await apiClient.get('/api/admin/group-admins', { params });
  return res.data as GroupAdminRow[];
}

export async function assignGroupAdmin(userId: string, groupId: string): Promise<GroupAdminRow> {
  const res = await apiClient.post('/api/admin/group-admins', { userId, groupId });
  return res.data as GroupAdminRow;
}

export async function removeGroupAdmin(id: string): Promise<void> {
  await apiClient.delete(`/api/admin/group-admins/${id}`);
}

// ── Members ───────────────────────────────────────────────────────────────────

export async function listGroupMembers(groupId: string): Promise<GroupMember[]> {
  const res = await apiClient.get(`/api/admin/groups/${groupId}/members`);
  return res.data as GroupMember[];
}

export type AccessDurationValue = 'PERMANENT' | 'ONE_DAY' | 'ONE_WEEK' | 'ONE_MONTH' | 'THREE_MONTHS';

export interface AddGroupMemberResult {
  // 'provisioned' = added immediately; 'queued' = the user's platform account isn't
  // finalized yet, so the grant applies automatically once their setup completes.
  kind: 'provisioned' | 'queued';
}

/** Admin override: add a user to a group directly (no request to review). */
export async function addGroupMember(
  groupId: string,
  body: { userId: string; levelId?: string; duration: AccessDurationValue },
): Promise<AddGroupMemberResult> {
  const res = await apiClient.post(`/api/admin/groups/${groupId}/members`, body);
  return res.data as AddGroupMemberResult;
}

export async function removeGroupMember(groupId: string, userAccessId: string): Promise<void> {
  await apiClient.delete(`/api/admin/groups/${groupId}/members/${userAccessId}`);
}

/** Admin override: set the level a member holds in a group. */
export async function setGroupMemberLevel(
  groupId: string,
  userAccessId: string,
  levelId: string,
): Promise<void> {
  await apiClient.put(`/api/admin/groups/${groupId}/members/${userAccessId}/level`, { levelId });
}

// ── Group levels (subgroups) ───────────────────────────────────────────────────

export interface GroupLevelRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  permission: string | null;
  externalGroupId: string | null;
  rank: number;
  isActive: boolean;
  memberCount: number;
}

export interface GroupLevelInput {
  name: string;
  slug: string;
  description?: string;
  permission?: string;
  externalGroupId?: string;
  rank?: number;
  isActive?: boolean;
}

export async function listGroupLevels(groupId: string): Promise<GroupLevelRow[]> {
  const res = await apiClient.get(`/api/admin/groups/${groupId}/levels`);
  return res.data as GroupLevelRow[];
}

export async function createGroupLevel(groupId: string, body: GroupLevelInput): Promise<GroupLevelRow> {
  const res = await apiClient.post(`/api/admin/groups/${groupId}/levels`, body);
  return res.data as GroupLevelRow;
}

export async function updateGroupLevel(
  groupId: string,
  levelId: string,
  body: Partial<GroupLevelInput>,
): Promise<GroupLevelRow & { reconciliation?: ReconciliationSummary | null }> {
  const res = await apiClient.put(`/api/admin/groups/${groupId}/levels/${levelId}`, body);
  return res.data as GroupLevelRow & { reconciliation?: ReconciliationSummary | null };
}

export interface DeleteGroupLevelResult {
  id: string;
  deleted: boolean;        // true = hard-deleted, false = deactivated (still has members or open requests)
  activeMembers?: number;
  openRequests?: number;
}

export async function deleteGroupLevel(groupId: string, levelId: string): Promise<DeleteGroupLevelResult> {
  const res = await apiClient.delete(`/api/admin/groups/${groupId}/levels/${levelId}`);
  return res.data as DeleteGroupLevelResult;
}

// Redash maintenance: backfill existing Redash accounts + memberships into Hermes.
// Rarely-used tool, surfaced in a collapsed disclosure on the Admin Management page.
export interface RedashImportReport {
  apply: boolean;
  mappedGroups: number;
  cachedUsers: number;
  usersMatched: number;
  usersSkippedNoKeycloak: string[];
  usersSkippedDisabled: string[];
  accountRequestsCreated: number;
  grantsCreated: number;
  grantsAlreadyPresent: number;
  membershipsUnmapped: string[];
  levelConflicts: string[];
}

export async function importRedashMemberships(apply: boolean, platform = 'redash'): Promise<RedashImportReport> {
  const res = await apiClient.post('/api/admin/import-redash-memberships', { apply, platform });
  return res.data as RedashImportReport;
}

// Redash full resync: two-way reconciliation. Adds memberships Hermes is missing
// (same as import), deactivates Hermes grants whose Redash membership is gone,
// swaps a grant to a different level when the user moved directly on Redash,
// repairs stale externalUserIds (user deleted + recreated on Redash), and
// reconciles requests stuck in WAITING_FOR_SETUP/PROVISIONING/PROVISION_FAILED.
// Manually triggered — not a cron job. Surfaced as a prominent button in the UI.
export interface RedashResyncReport extends RedashImportReport {
  grantsDeactivated: number;
  // Subset of grantsDeactivated whose Redash account was disabled (rather than
  // just removed from the group) — same list, distinguishable by label suffix.
  grantsDeactivatedDisabled: number;
  deactivatedGrants: string[];
  activeGrantsSkippedUnmapped: string[];
  removePassSkippedEmptyCache: boolean;
  // True when the platform's health check failed (or threw) — the remove pass
  // was skipped entirely since a degraded response can look like valid data.
  removePassSkippedUnhealthy: boolean;
  removePassUnhealthyMessage: string | null;
  // True when the remove pass found more orphaned grants than the safety cap
  // allows and refused to write them (dry-run/created/swapped/refreshed still
  // happened) — re-run with force=true to proceed anyway.
  removePassBlockedBySafetyCap: boolean;
  removePassSafetyCapThreshold: number | null;
  levelsSwapped: number;
  swappedGrants: string[];
  externalUserIdsRefreshed: number;
  refreshedExternalUserIds: string[];
  requestsReconciled: number;
  reconciledRequests: string[];
  stuckReported: string[];
  // Report-only: a DRAFT/PENDING/REJECTED account request whose user already
  // has a working Redash account (e.g. a rejection bypassed directly on Redash).
  // Never auto-resolved — surfaced for admin review.
  accountRequestDrift: string[];
  errors: string[];
}

export async function resyncRedashMemberships(
  apply: boolean,
  platform = 'redash',
  force = false,
): Promise<RedashResyncReport> {
  const res = await apiClient.post('/api/admin/resync-redash-memberships', { apply, platform, force });
  return res.data as RedashResyncReport;
}

// ZooKeeper maintenance: migrate existing ZooKeeper ACLs to world-open (world:anyone:cdrwa)
export interface ZookeeperMigrationReport {
  apply: boolean;
  targetRoots: string[];
  pathsFound: string[];
  updatedCount: number;
  failedPaths: { path: string; error: string }[];
}

export async function migrateZookeeperAcls(apply: boolean): Promise<ZookeeperMigrationReport> {
  const res = await apiClient.post('/api/admin/migrate-zookeeper-acls', { apply });
  return res.data as ZookeeperMigrationReport;
}

