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
  color: string | null;
  icon: string | null;
  memberCount: number;
  adminCount: number;
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

export async function removeGroupMember(groupId: string, userAccessId: string): Promise<void> {
  await apiClient.delete(`/api/admin/groups/${groupId}/members/${userAccessId}`);
}
