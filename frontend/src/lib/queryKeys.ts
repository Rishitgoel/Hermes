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
};
