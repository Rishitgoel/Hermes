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
const mockDelete = vi.fn();
vi.mock('axios', () => ({
  default: {
    create: () => ({
      get: mockGet,
      delete: mockDelete,
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

/**
 * Regression coverage for the revoke false-drop bug: removeUserFromGroup used to
 * throw on ANY error, including a 404 for a membership that was already gone (user
 * removed from the group, or deleted, directly on Redash). That forced revokeAccess
 * to guess from a possibly-stale cache whether the membership was really absent,
 * which could silently drop a grant while the user still had platform access.
 * Making removal idempotent to a 404 (like disableUser/deleteGroup) fixes it at the
 * source: an already-gone membership is a clean no-op, a real error still throws.
 */
describe('RedashService.removeUserFromGroup — idempotent on already-gone membership', () => {
  beforeEach(() => {
    mockDelete.mockReset();
  });

  function makeService() {
    return new RedashService({ key: 'redash', baseUrl: 'https://redash.example.com', apiKey: 'key', isSimulation: false });
  }

  it('swallows a 404 (membership/user already absent) instead of throwing', async () => {
    mockDelete.mockRejectedValueOnce({ response: { status: 404 }, message: 'Not Found' });
    await expect(makeService().removeUserFromGroup(7, 5)).resolves.toBeUndefined();
    expect(mockDelete).toHaveBeenCalledWith('/api/groups/5/members/7');
  });

  it('still throws on a real (non-404) error so a transient failure is not mistaken for success', async () => {
    mockDelete.mockRejectedValueOnce({ response: { status: 500 }, message: 'Server Error' });
    await expect(makeService().removeUserFromGroup(7, 5)).rejects.toThrow('removeUserFromGroup error');
  });
});
