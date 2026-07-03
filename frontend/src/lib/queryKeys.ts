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
  audit: (params: {
    page: number;
    pageSize: number;
    action: string;
    search: string;
    performerId?: string;
    fromDate?: string;
    toDate?: string;
    groupId?: string;
    platform?: string;
  }) => ['audit', params] as const,
  platformStatus: (platform: string) => ['platform-status', platform] as const,
  pendingUserCreations: () => ['pending-user-creations'] as const,
  // Per-platform account-creation status for the current user.
  userCreation: (platform: string) => ['user-creation', platform] as const,
  userCreations: () => ['user-creation', 'all'] as const,
  // Platform keys with a live provisioning adapter (from the backend registry).
  platforms: () => ['platforms'] as const,

  // ZooKeeper config management
  zkScope: () => ['zk', 'scope'] as const,
  zkNodes: (path: string) => ['zk', 'nodes', path] as const,
  zkChangeRequests: (scope: 'mine' | 'review') => ['zk', 'change-requests', scope] as const,

  // Admin Management
  adminPlatforms: () => ['admin', 'platforms'] as const,
  adminUsers: (search: string) => ['admin', 'users', search] as const,
  adminGroups: (platform: string) => ['admin', 'groups', platform] as const,
  adminPlatformAdmins: (platform: string) => ['admin', 'platform-admins', platform] as const,
  adminGroupAdmins: (platform: string) => ['admin', 'group-admins', platform] as const,
  // Group admins scoped to a single group (used by the group detail drawer). Shares
  // the ['admin','group-admins'] prefix so a prefix-invalidate refreshes both.
  adminGroupAdminsForGroup: (groupId: string) => ['admin', 'group-admins', 'group', groupId] as const,
  adminGroupMembers: (groupId: string) => ['admin', 'group-members', groupId] as const,
  adminGroupLevels: (groupId: string) => ['admin', 'group-levels', groupId] as const,
  adminUserAccess: (userId: string) => ['admin', 'user-access', userId] as const,
  adminUserPlatformAccounts: (userId: string) => ['admin', 'user-platform-accounts', userId] as const,
};
