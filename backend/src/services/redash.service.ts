import logger from '../utils/logger';
import config from '../config/config';
import { createHttpClient } from '../utils/http-client';
import { normalizeRedashInviteLink } from '../utils/redash-url';

export interface RedashUserResponse {
  id: number;
  name: string;
  email: string;
  is_disabled: boolean;
  is_invitation_pending: boolean;
  groups: number[];
}

export interface RedashGroupResponse {
  id: number;
  name: string;
  type: string;
}

/** Connection details for one Redash server (prod, qa, ...). */
export interface RedashInstanceConfig {
  /** Instance key, e.g. "redash" (prod) or "redash-qa". Used only for log prefixes. */
  key: string;
  baseUrl: string;
  apiKey: string;
  isSimulation: boolean;
}

export class RedashService {
  private readonly key: string;
  private baseUrl: string;
  private apiKey: string;
  private isSimulation: boolean;

  /**
   * Per-Redash-user serialization for group-membership mutations. Redash's
   * add/remove-member endpoints do a non-atomic read-modify-write on the user's
   * `group_ids` array, so two concurrent mutations for the SAME user clobber each
   * other (lost update). Approving N groups in bulk fires N concurrent calls and
   * would silently drop a membership while still returning 200. We chain same-user
   * mutations so each one observes the previous one's committed state. In-process
   * only (Hermes runs single-instance); keyed by Redash user id so different users
   * still mutate in parallel.
   */
  private userMutationChains = new Map<number, Promise<unknown>>();

  constructor(instance: RedashInstanceConfig) {
    this.key = instance.key;
    this.baseUrl = instance.baseUrl;
    this.apiKey = instance.apiKey;
    this.isSimulation = instance.isSimulation;
  }

  /** This instance's configured base URL (used for launch links / invite-link fallbacks). */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** Whether this instance is running against mock data instead of a real Redash server. */
  getIsSimulation(): boolean {
    return this.isSimulation;
  }

  private getClient() {
    return createHttpClient({
      baseURL: this.baseUrl,
      headers: {
        Authorization: `Key ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /** Run `task` only after any in-flight membership mutation for the same Redash
   *  user has settled, serializing all of one user's mutations. */
  private withUserLock<T>(redashUserId: number, task: () => Promise<T>): Promise<T> {
    const prev = this.userMutationChains.get(redashUserId) ?? Promise.resolve();
    // Run the task whether or not the previous one in the chain succeeded.
    const run = prev.then(task, task);
    // Store a non-throwing tail so a failed task can't poison the next waiter,
    // and clean the map entry once we're the last link to avoid unbounded growth.
    const tail = run.catch(() => {});
    this.userMutationChains.set(redashUserId, tail);
    // Fire-and-forget map cleanup once this link settles (no need to await it).
    void tail.then(() => {
      if (this.userMutationChains.get(redashUserId) === tail) {
        this.userMutationChains.delete(redashUserId);
      }
    });
    return run;
  }

  // Sync Users: Fetches all active users from Redash
  async syncUsers(): Promise<RedashUserResponse[]> {
    if (this.isSimulation) {
      logger.info(`📊 Redash[${this.key}] syncUsers (Simulation): Returning mock users.`);
      return [
        { id: 1, name: 'Mayank Aggarwal', email: 'mayank.aggarwal@bachatt.app', is_disabled: false, is_invitation_pending: false, groups: [1, 2] },
        { id: 2, name: 'Yogesh Verma', email: 'yogesh.verma@bachatt.app', is_disabled: false, is_invitation_pending: false, groups: [1, 101] },
        { id: 3, name: 'Rishit Goel', email: 'rishit.goel@bachatt.app', is_disabled: false, is_invitation_pending: false, groups: [1] },
        { id: 4, name: 'Ankit Sharma', email: 'ankit.sharma@bachatt.app', is_disabled: false, is_invitation_pending: false, groups: [1, 2] },
      ];
    }

    try {
      const client = this.getClient();
      // Redash's /api/users is paginated ({count, page, page_size, results}) —
      // fetching only page 1 silently truncates any roster over one page. A
      // truncated fetch isn't just an incomplete cache: the resync's remove
      // pass treats "missing from the fetch" as "no longer a member" and would
      // deactivate every grant for every user past the first page. Loop until
      // every page is collected (or the count is satisfied).
      const pageSize = 250;
      const MAX_PAGES = 200; // sanity bound (50k users) against a runaway/misbehaving API
      const results: any[] = [];
      let page = 1;
      for (; page <= MAX_PAGES; page++) {
        const response = await client.get(`/api/users?page_size=${pageSize}&page=${page}`);
        const pageResults = response.data.results ?? [];
        results.push(...pageResults);
        const count = typeof response.data.count === 'number' ? response.data.count : results.length;
        if (pageResults.length === 0 || results.length >= count) break;
      }
      if (page > MAX_PAGES) {
        logger.error(`Redash[${this.key}] syncUsers: hit the ${MAX_PAGES}-page safety cap — the user list may be truncated.`);
      }
      return results.map((u: any) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        is_disabled: u.is_disabled,
        is_invitation_pending: !!u.is_invitation_pending,
        // Modern Redash returns `groups` as an array of {id, name} objects;
        // older builds (and the sim shim) return plain integer IDs. Normalize
        // to Int[] so the `RedashUser.groupIds Int[]` column accepts it.
        groups: Array.isArray(u.groups)
          ? u.groups.map((g: any) => (typeof g === 'number' ? g : g?.id)).filter((g: any) => typeof g === 'number')
          : [],
      }));
    } catch (error: any) {
      logger.error(`Failed to sync users from Redash[${this.key}] API:`, error.message);
      throw new Error(`Redash[${this.key}] API syncUsers error: ${error.message}`);
    }
  }

  // Fetch a single user by email from Redash (Fast-path single sync)
  async fetchUserByEmail(email: string): Promise<RedashUserResponse | null> {
    if (this.isSimulation) {
      const lower = email.toLowerCase();
      const mock = [
        { id: 1, name: 'Mayank Aggarwal', email: 'mayank.aggarwal@bachatt.app', is_disabled: false, is_invitation_pending: false, groups: [1, 2] },
        { id: 2, name: 'Yogesh Verma', email: 'yogesh.verma@bachatt.app', is_disabled: false, is_invitation_pending: false, groups: [1, 101] },
        { id: 3, name: 'Rishit Goel', email: 'rishit.goel@bachatt.app', is_disabled: false, is_invitation_pending: false, groups: [1] },
        { id: 4, name: 'Ankit Sharma', email: 'ankit.sharma@bachatt.app', is_disabled: false, is_invitation_pending: false, groups: [1, 2] },
      ].find(u => u.email === lower);
      return mock || null;
    }

    try {
      const client = this.getClient();
      const searchRes = await client.get(`/api/users?q=${encodeURIComponent(email)}`);
      const u = searchRes.data.results.find((u: any) => u.email.toLowerCase() === email.toLowerCase());
      if (!u) return null;
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        is_disabled: u.is_disabled,
        is_invitation_pending: !!u.is_invitation_pending,
        groups: Array.isArray(u.groups)
          ? u.groups.map((g: any) => (typeof g === 'number' ? g : g?.id)).filter((g: any) => typeof g === 'number')
          : [],
      };
    } catch (error: any) {
      logger.error(`Failed to fetch user ${email} from Redash[${this.key}] API:`, error.message);
      return null;
    }
  }

  // Sync Groups: Fetches all groups from Redash
  async syncGroups(): Promise<RedashGroupResponse[]> {
    if (this.isSimulation) {
      logger.info(`📊 Redash[${this.key}] syncGroups (Simulation): Returning mock groups.`);
      return [
        { id: 1, name: 'default', type: 'builtin' },
        { id: 2, name: 'admin', type: 'builtin' },
        { id: 101, name: 'Growth', type: 'regular' },
        { id: 102, name: 'Retention', type: 'regular' },
        { id: 103, name: 'Lending', type: 'regular' },
        { id: 104, name: 'Credit Card', type: 'regular' },
        { id: 105, name: 'Customer Support', type: 'regular' },
        { id: 106, name: 'Marketing', type: 'regular' },
        // Per-level groups backing Credit Card's permission levels (see seed.ts).
        { id: 1041, name: 'Credit Card — Intern', type: 'regular' },
        { id: 1042, name: 'Credit Card — Junior Dev', type: 'regular' },
        { id: 1043, name: 'Credit Card — Senior Dev', type: 'regular' },
      ];
    }

    try {
      const client = this.getClient();
      const response = await client.get('/api/groups');
      return response.data.map((g: any) => ({
        id: g.id,
        name: g.name,
        type: g.type,
      }));
    } catch (error: any) {
      logger.error(`Failed to sync groups from Redash[${this.key}] API:`, error.message);
      throw new Error(`Redash[${this.key}] API syncGroups error: ${error.message}`);
    }
  }

  /**
   * Result of `findOrInviteUser`:
   *  - `id` is the Redash user ID, populated either way.
   *  - `inviteLink` is the Redash-issued one-time setup URL, present ONLY when
   *    we just created a fresh invited user. Returns undefined when the user
   *    already existed (no setup needed).
   */
  async findOrInviteUser(email: string, name: string): Promise<{ id: number; inviteLink?: string }> {
    if (this.isSimulation) {
      logger.info(`📊 Redash[${this.key}] findOrInviteUser (Simulation): Mocking lookup/invite for ${email}`);
      const lowerEmail = email.toLowerCase();
      // Stable mock IDs for seeded users — and no inviteLink because they already exist.
      if (lowerEmail === 'mayank.aggarwal@bachatt.app') return { id: 1 };
      if (lowerEmail === 'yogesh.verma@bachatt.app') return { id: 2 };
      if (lowerEmail === 'rishit.goel@bachatt.app') return { id: 3 };
      if (lowerEmail === 'ankit.sharma@bachatt.app') return { id: 4 };
      // For any other email, simulate a fresh invite — return a fake inviteLink so
      // the rest of the workflow can be exercised end-to-end in sim mode.
      const fakeId = Math.floor(Math.random() * 9000) + 1000;
      const baseUrl = this.baseUrl?.replace(/\/$/, '') || 'https://redash.bachatt.app';
      const fakeToken = Math.random().toString(36).slice(2, 18);
      return { id: fakeId, inviteLink: `${baseUrl}/invitations/${fakeToken}` };
    }

    try {
      const client = this.getClient();
      // Search user by email
      const searchRes = await client.get(`/api/users?q=${encodeURIComponent(email)}`);
      const existing = searchRes.data.results.find((u: any) => u.email.toLowerCase() === email.toLowerCase());

      if (existing) {
        logger.info(`📊 Redash[${this.key}] findOrInviteUser: Found existing user ${email} with ID ${existing.id}`);
        
        // If the user's invitation is pending, generate and return a new invite link
        if (existing.is_invitation_pending) {
          logger.info(`📊 Redash[${this.key}] findOrInviteUser: Existing user ${email} invitation is pending. Generating new invite link...`);
          try {
            const inviteRes = await client.post(`/api/users/${existing.id}/invite`);
            const rawLink: string | undefined =
              typeof inviteRes.data?.invite_link === 'string' ? inviteRes.data.invite_link : undefined;
            const inviteLink = normalizeRedashInviteLink(rawLink, this.baseUrl);
            return { id: existing.id, inviteLink };
          } catch (inviteErr: any) {
            logger.warn({ email, error: inviteErr.message }, 'Failed to generate invite link for existing pending user; proceeding without it');
          }
        }
        return { id: existing.id };
      }

      // Create new user (invite). Redash returns `invite_link` in the response body
      // when a fresh invite is created — we capture and surface it inside Hermes.
      logger.info(`📊 Redash[${this.key}] findOrInviteUser: User ${email} not found. Sending invite...`);
      const inviteRes = await client.post('/api/users', {
        name,
        email,
      });
      const rawLink: string | undefined =
        typeof inviteRes.data?.invite_link === 'string' ? inviteRes.data.invite_link : undefined;
      const inviteLink = normalizeRedashInviteLink(rawLink, this.baseUrl);

      logger.info(
        `📊 Redash[${this.key}] findOrInviteUser: Successfully invited user ${email} with ID ${inviteRes.data.id}${inviteLink ? ' (normalized invite link)' : ''}`,
      );
      return { id: inviteRes.data.id, inviteLink };
    } catch (error: any) {
      logger.error(`Failed to find/invite user ${email} in Redash[${this.key}]:`, error.message);
      throw new Error(`Redash[${this.key}] API invite error: ${error.message}`);
    }
  }

  /**
   * Generate a fresh invite link for an existing Redash user. Use this in the
   * resend-invite path: relying on `findOrInviteUser` to also regenerate links
   * is fragile because that path swallows invite-endpoint failures.
   *
   * Returns the normalized invite URL, or null in simulation mode / on failure.
   */
  async regenerateInviteLink(redashUserId: number): Promise<string | null> {
    if (this.isSimulation) {
      const baseUrl = this.baseUrl?.replace(/\/$/, '') || 'https://redash.bachatt.app';
      const fakeToken = Math.random().toString(36).slice(2, 18);
      return `${baseUrl}/invitations/${fakeToken}`;
    }

    try {
      const client = this.getClient();
      const res = await client.post(`/api/users/${redashUserId}/invite`);
      const rawLink: string | undefined =
        typeof res.data?.invite_link === 'string' ? res.data.invite_link : undefined;
      return normalizeRedashInviteLink(rawLink, this.baseUrl) ?? null;
    } catch (err: any) {
      logger.error(`Failed to regenerate invite link for Redash[${this.key}] user ${redashUserId}: ${err.message}`);
      throw new Error(`Redash[${this.key}] API regenerateInviteLink error: ${err.message}`);
    }
  }

  // Add User to Group
  async addUserToGroup(redashUserId: number, redashGroupId: number): Promise<void> {
    if (this.isSimulation) {
      logger.info(`📊 Redash[${this.key}] addUserToGroup (Simulation): Added Redash User ID ${redashUserId} to Group ID ${redashGroupId}`);
      return;
    }

    // Serialize per user: concurrent adds for one user race on Redash's group_ids
    // array and lose memberships (see withUserLock).
    return this.withUserLock(redashUserId, async () => {
      try {
        const client = this.getClient();
        await client.post(`/api/groups/${redashGroupId}/members`, {
          user_id: redashUserId,
        });
        logger.info(`📊 Redash[${this.key}]: Successfully added User ${redashUserId} to Group ${redashGroupId}`);
      } catch (error: any) {
        // Check if user is already a member
        if (error.response && error.response.status === 400 && error.response.data?.message?.includes('already a member')) {
          logger.info(`📊 Redash[${this.key}]: User ${redashUserId} is already a member of Group ${redashGroupId}`);
          return;
        }
        logger.error(`Failed to add user ${redashUserId} to group ${redashGroupId} in Redash[${this.key}]:`, error.message);
        throw new Error(`Redash[${this.key}] API addUserToGroup error: ${error.message}`);
      }
    });
  }

  // Remove User from Group
  async removeUserFromGroup(redashUserId: number, redashGroupId: number): Promise<void> {
    if (this.isSimulation) {
      logger.info(`📊 Redash[${this.key}] removeUserFromGroup (Simulation): Removed Redash User ID ${redashUserId} from Group ID ${redashGroupId}`);
      return;
    }

    // Serialize per user alongside adds — a remove and an add for the same user
    // racing on the group_ids array would otherwise clobber each other too.
    return this.withUserLock(redashUserId, async () => {
      try {
        const client = this.getClient();
        await client.delete(`/api/groups/${redashGroupId}/members/${redashUserId}`);
        logger.info(`📊 Redash[${this.key}]: Successfully removed User ${redashUserId} from Group ${redashGroupId}`);
      } catch (error: any) {
        // Tolerate a 404 (membership/user already gone) so removal is idempotent —
        // matches disableUser/deleteGroup here and AWS's removeUserFromGroup. This is
        // what lets a revoke succeed cleanly when the user was removed from the group
        // (or deleted) directly in Redash, without the caller having to guess from a
        // possibly-stale cache whether the membership was really absent.
        if (error.response && error.response.status === 404) {
          logger.info(`📊 Redash[${this.key}]: User ${redashUserId} already absent from Group ${redashGroupId}; nothing to remove`);
          return;
        }
        logger.error(`Failed to remove user ${redashUserId} from group ${redashGroupId} in Redash[${this.key}]:`, error.message);
        throw new Error(`Redash[${this.key}] API removeUserFromGroup error: ${error.message}`);
      }
    });
  }

  // Create a new Redash group; returns its server-assigned id. Permissions
  // (data-source access) are configured separately in Redash — Hermes only
  // owns the group's existence and membership.
  async createGroup(name: string): Promise<{ id: number; name: string }> {
    if (this.isSimulation) {
      const fakeId = Math.floor(Math.random() * 9000) + 1000;
      logger.info(`📊 Redash[${this.key}] createGroup (Simulation): Created Group "${name}" with ID ${fakeId}`);
      return { id: fakeId, name };
    }

    try {
      const client = this.getClient();
      const res = await client.post('/api/groups', { name });
      logger.info(`📊 Redash[${this.key}]: Created Group "${name}" with ID ${res.data.id}`);
      return { id: res.data.id, name: res.data.name ?? name };
    } catch (error: any) {
      logger.error(`Failed to create group "${name}" in Redash[${this.key}]:`, error.message);
      throw new Error(`Redash[${this.key}] API createGroup error: ${error.message}`);
    }
  }

  /**
   * Disable a Redash user's ACCOUNT (offboarding — not group membership, which is
   * addUserToGroup/removeUserFromGroup). Redash's `DELETE /api/users/:id` is a
   * soft-disable: it sets `is_disabled=true` and blocks sign-in, but doesn't purge
   * the user or their history — an admin can flip it back in Redash's own admin
   * panel. Tolerates a 404 (already gone) so it's safe to call twice.
   */
  async disableUser(redashUserId: number): Promise<void> {
    if (this.isSimulation) {
      logger.info(`📊 Redash[${this.key}] disableUser (Simulation): Disabled User ID ${redashUserId}`);
      return;
    }

    try {
      const client = this.getClient();
      await client.delete(`/api/users/${redashUserId}`);
      logger.info(`📊 Redash[${this.key}]: Disabled User ID ${redashUserId}`);
    } catch (error: any) {
      if (error.response && error.response.status === 404) {
        logger.info(`📊 Redash[${this.key}]: User ID ${redashUserId} already absent; nothing to disable`);
        return;
      }
      logger.error(`Failed to disable user ${redashUserId} in Redash[${this.key}]:`, error.message);
      throw new Error(`Redash[${this.key}] API disableUser error: ${error.message}`);
    }
  }

  // Delete a Redash group by id. Tolerates a 404 (already gone) so cleanup is idempotent.
  async deleteGroup(redashGroupId: number): Promise<void> {
    if (this.isSimulation) {
      logger.info(`📊 Redash[${this.key}] deleteGroup (Simulation): Deleted Group ID ${redashGroupId}`);
      return;
    }

    try {
      const client = this.getClient();
      await client.delete(`/api/groups/${redashGroupId}`);
      logger.info(`📊 Redash[${this.key}]: Deleted Group ID ${redashGroupId}`);
    } catch (error: any) {
      if (error.response && error.response.status === 404) {
        logger.info(`📊 Redash[${this.key}]: Group ID ${redashGroupId} already absent; nothing to delete`);
        return;
      }
      logger.error(`Failed to delete group ${redashGroupId} in Redash[${this.key}]:`, error.message);
      throw new Error(`Redash[${this.key}] API deleteGroup error: ${error.message}`);
    }
  }
}

const instanceCache = new Map<string, RedashService>();

/** One RedashService per instance key (prod, qa, ...), cached so repeated
 *  registration/lookup for the same instance reuses its axios client and
 *  per-user mutation locks instead of creating a fresh one each time. */
export function getRedashService(instance: RedashInstanceConfig): RedashService {
  let svc = instanceCache.get(instance.key);
  if (!svc) {
    svc = new RedashService(instance);
    instanceCache.set(instance.key, svc);
  }
  return svc;
}

// Back-compat default export: the prod instance, sourced from config.redash.
// Existing callers (redash.provisioner.ts) keep working unchanged until they
// move to getRedashService() with an explicit instance.
export const redashService = getRedashService({
  key: 'redash',
  baseUrl: config.redash.baseUrl,
  apiKey: config.redash.apiKey,
  isSimulation: config.redash.isSimulation,
});
export default redashService;
