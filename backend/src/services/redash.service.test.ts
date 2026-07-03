import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression coverage for the pagination bug: /api/users is paginated
 * ({count, page, page_size, results}); syncUsers() used to fetch only page 1,
 * silently truncating any roster over 250 users. That's not just an
 * incomplete cache — the resync's remove pass treats "missing from the
 * fetch" as "no longer a member" and would mass-deactivate every grant for
 * every user past the first page.
 */
const mockGet = vi.fn();
vi.mock('axios', () => ({
  default: {
    create: () => ({
      get: mockGet,
      interceptors: { response: { use: vi.fn() } },
    }),
  },
}));

import { RedashService } from './redash.service';

function makeUser(id: number) {
  return { id, name: `User ${id}`, email: `user${id}@bachatt.app`, is_disabled: false, is_invitation_pending: false, groups: [1] };
}

describe('RedashService.syncUsers — pagination', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  function makeService() {
    return new RedashService({ key: 'redash', baseUrl: 'https://redash.example.com', apiKey: 'key', isSimulation: false });
  }

  it('fetches every page instead of stopping at page 1', async () => {
    mockGet.mockResolvedValueOnce({
      data: { count: 300, page: 1, page_size: 250, results: Array.from({ length: 250 }, (_, i) => makeUser(i + 1)) },
    });
    mockGet.mockResolvedValueOnce({
      data: { count: 300, page: 2, page_size: 250, results: Array.from({ length: 50 }, (_, i) => makeUser(250 + i + 1)) },
    });

    const users = await makeService().syncUsers();

    expect(users).toHaveLength(300);
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockGet).toHaveBeenNthCalledWith(1, '/api/users?page_size=250&page=1');
    expect(mockGet).toHaveBeenNthCalledWith(2, '/api/users?page_size=250&page=2');
    expect(users[0].id).toBe(1);
    expect(users[299].id).toBe(300);
  });

  it('stops after one page when the full roster fits', async () => {
    mockGet.mockResolvedValueOnce({
      data: { count: 3, page: 1, page_size: 250, results: [makeUser(1), makeUser(2), makeUser(3)] },
    });

    const users = await makeService().syncUsers();

    expect(users).toHaveLength(3);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('stops on an empty results page instead of looping forever', async () => {
    mockGet.mockResolvedValueOnce({
      data: { count: 999, page: 1, page_size: 250, results: [] },
    });

    const users = await makeService().syncUsers();

    expect(users).toHaveLength(0);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
