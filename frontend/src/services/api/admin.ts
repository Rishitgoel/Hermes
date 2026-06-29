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

export async function importRedashMemberships(apply: boolean): Promise<RedashImportReport> {
  const res = await apiClient.post('/api/admin/import-redash-memberships', { apply });
  return res.data as RedashImportReport;
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

