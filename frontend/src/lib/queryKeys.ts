/**
 * Centralised React Query keys. Use these instead of hand-rolled tuples so
 * mutations can invalidate consistently and a TS rename catches every caller.
 */
export const queryKeys = {
  groups: () => ['groups'] as const,
  groupDetail: (slug: string) => ['groups', slug] as const,
  myAccess: () => ['my-access'] as const,
  myRequests: () => ['my-requests'] as const,
  pendingRequests: () => ['pending-requests'] as const,
  audit: (params: { page: number; pageSize: number; action: string; search: string }) =>
    ['audit', params] as const,
  platformStatus: (platform: string) => ['platform-status', platform] as const,
  pendingUserCreations: () => ['pending-user-creations'] as const,
  // Per-platform account-creation status for the current user.
  userCreation: (platform: string) => ['user-creation', platform] as const,
  userCreations: () => ['user-creation', 'all'] as const,
  // Platform keys with a live provisioning adapter (from the backend registry).
  platforms: () => ['platforms'] as const,

  // Admin Management
  adminPlatforms: () => ['admin', 'platforms'] as const,
  adminUsers: (search: string) => ['admin', 'users', search] as const,
  adminGroups: (platform: string) => ['admin', 'groups', platform] as const,
  adminPlatformAdmins: (platform: string) => ['admin', 'platform-admins', platform] as const,
  adminGroupAdmins: (platform: string) => ['admin', 'group-admins', platform] as const,
  adminGroupMembers: (groupId: string) => ['admin', 'group-members', groupId] as const,
  adminGroupLevels: (groupId: string) => ['admin', 'group-levels', groupId] as const,
};
