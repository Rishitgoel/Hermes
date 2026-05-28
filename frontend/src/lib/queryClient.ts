import { QueryClient } from '@tanstack/react-query';

/**
 * Single app-wide React Query client.
 *
 * Defaults tuned for Atlas:
 *  - 30s staleTime so navigating between pages doesn't refetch immediately,
 *    but data still gets refreshed on a reasonable cadence.
 *  - retry: 1 — most failures here are auth/permission errors that won't
 *    succeed on retry. apiClient already does its own 401-retry-with-refresh.
 *  - refetchOnWindowFocus stays on (RQ default) so coming back to the tab
 *    pulls fresh data.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
    mutations: {
      retry: 0,
    },
  },
});
