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

export class RedashService {
  private baseUrl: string;
  private apiKey: string;
  private isSimulation: boolean;

  constructor() {
    this.baseUrl = config.redash.baseUrl;
    this.apiKey = config.redash.apiKey;
    this.isSimulation = config.redash.isSimulation;
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

  // Sync Users: Fetches all active users from Redash
  async syncUsers(): Promise<RedashUserResponse[]> {
    if (this.isSimulation) {
      logger.info('📊 Redash syncUsers (Simulation): Returning mock users.');
      return [
        { id: 1, name: 'Mayank Aggarwal', email: 'mayank.aggarwal@bachatt.app', is_disabled: false, is_invitation_pending: false, groups: [1, 2] },
        { id: 2, name: 'Yogesh Verma', email: 'yogesh.verma@bachatt.app', is_disabled: false, is_invitation_pending: false, groups: [1, 101] },
        { id: 3, name: 'Rishit Goel', email: 'rishit.goel@bachatt.app', is_disabled: false, is_invitation_pending: false, groups: [1] },
        { id: 4, name: 'Ankit Sharma', email: 'ankit.sharma@bachatt.app', is_disabled: false, is_invitation_pending: false, groups: [1, 2] },
      ];
    }

    try {
      const client = this.getClient();
      // Redash users API uses pagination
      const response = await client.get('/api/users?page_size=250');
      return response.data.results.map((u: any) => ({
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
      logger.error('Failed to sync users from Redash API:', error.message);
      throw new Error(`Redash API syncUsers error: ${error.message}`);
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
      logger.error(`Failed to fetch user ${email} from Redash API:`, error.message);
      return null;
    }
  }

  // Sync Groups: Fetches all groups from Redash
  async syncGroups(): Promise<RedashGroupResponse[]> {
    if (this.isSimulation) {
      logger.info('📊 Redash syncGroups (Simulation): Returning mock groups.');
      return [
        { id: 1, name: 'default', type: 'builtin' },
        { id: 2, name: 'admin', type: 'builtin' },
        { id: 101, name: 'Growth', type: 'regular' },
        { id: 102, name: 'Retention', type: 'regular' },
        { id: 103, name: 'Lending', type: 'regular' },
        { id: 104, name: 'Credit Card', type: 'regular' },
        { id: 105, name: 'Customer Support', type: 'regular' },
        { id: 106, name: 'Marketing', type: 'regular' },
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
      logger.error('Failed to sync groups from Redash API:', error.message);
      throw new Error(`Redash API syncGroups error: ${error.message}`);
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
      logger.info(`📊 Redash findOrInviteUser (Simulation): Mocking lookup/invite for ${email}`);
      const lowerEmail = email.toLowerCase();
      // Stable mock IDs for seeded users — and no inviteLink because they already exist.
      if (lowerEmail === 'mayank.aggarwal@bachatt.app') return { id: 1 };
      if (lowerEmail === 'yogesh.verma@bachatt.app') return { id: 2 };
      if (lowerEmail === 'rishit.goel@bachatt.app') return { id: 3 };
      if (lowerEmail === 'ankit.sharma@bachatt.app') return { id: 4 };
      // For any other email, simulate a fresh invite — return a fake inviteLink so
      // the rest of the workflow can be exercised end-to-end in sim mode.
      const fakeId = Math.floor(Math.random() * 9000) + 1000;
      const baseUrl = config.redash.baseUrl?.replace(/\/$/, '') || 'https://redash.bachatt.app';
      const fakeToken = Math.random().toString(36).slice(2, 18);
      return { id: fakeId, inviteLink: `${baseUrl}/invitations/${fakeToken}` };
    }

    try {
      const client = this.getClient();
      // Search user by email
      const searchRes = await client.get(`/api/users?q=${encodeURIComponent(email)}`);
      const existing = searchRes.data.results.find((u: any) => u.email.toLowerCase() === email.toLowerCase());

      if (existing) {
        logger.info(`📊 Redash findOrInviteUser: Found existing user ${email} with ID ${existing.id}`);
        
        // If the user's invitation is pending, generate and return a new invite link
        if (existing.is_invitation_pending) {
          logger.info(`📊 Redash findOrInviteUser: Existing user ${email} invitation is pending. Generating new invite link...`);
          try {
            const inviteRes = await client.post(`/api/users/${existing.id}/invite`);
            const rawLink: string | undefined =
              typeof inviteRes.data?.invite_link === 'string' ? inviteRes.data.invite_link : undefined;
            const inviteLink = normalizeRedashInviteLink(rawLink);
            return { id: existing.id, inviteLink };
          } catch (inviteErr: any) {
            logger.warn({ email, error: inviteErr.message }, 'Failed to generate invite link for existing pending user; proceeding without it');
          }
        }
        return { id: existing.id };
      }

      // Create new user (invite). Redash returns `invite_link` in the response body
      // when a fresh invite is created — we capture and surface it inside Hermes.
      logger.info(`📊 Redash findOrInviteUser: User ${email} not found. Sending invite...`);
      const inviteRes = await client.post('/api/users', {
        name,
        email,
      });
      const rawLink: string | undefined =
        typeof inviteRes.data?.invite_link === 'string' ? inviteRes.data.invite_link : undefined;
      const inviteLink = normalizeRedashInviteLink(rawLink);

      logger.info(
        `📊 Redash findOrInviteUser: Successfully invited user ${email} with ID ${inviteRes.data.id}${inviteLink ? ' (normalized invite link)' : ''}`,
      );
      return { id: inviteRes.data.id, inviteLink };
    } catch (error: any) {
      logger.error(`Failed to find/invite user ${email} in Redash:`, error.message);
      throw new Error(`Redash API invite error: ${error.message}`);
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
      const baseUrl = config.redash.baseUrl?.replace(/\/$/, '') || 'https://redash.bachatt.app';
      const fakeToken = Math.random().toString(36).slice(2, 18);
      return `${baseUrl}/invitations/${fakeToken}`;
    }

    try {
      const client = this.getClient();
      const res = await client.post(`/api/users/${redashUserId}/invite`);
      const rawLink: string | undefined =
        typeof res.data?.invite_link === 'string' ? res.data.invite_link : undefined;
      return normalizeRedashInviteLink(rawLink) ?? null;
    } catch (err: any) {
      logger.error(`Failed to regenerate invite link for Redash user ${redashUserId}: ${err.message}`);
      throw new Error(`Redash API regenerateInviteLink error: ${err.message}`);
    }
  }

  // Add User to Group
  async addUserToGroup(redashUserId: number, redashGroupId: number): Promise<void> {
    if (this.isSimulation) {
      logger.info(`📊 Redash addUserToGroup (Simulation): Added Redash User ID ${redashUserId} to Group ID ${redashGroupId}`);
      return;
    }

    try {
      const client = this.getClient();
      await client.post(`/api/groups/${redashGroupId}/members`, {
        user_id: redashUserId,
      });
      logger.info(`📊 Redash: Successfully added User ${redashUserId} to Group ${redashGroupId}`);
    } catch (error: any) {
      // Check if user is already a member
      if (error.response && error.response.status === 400 && error.response.data?.message?.includes('already a member')) {
        logger.info(`📊 Redash: User ${redashUserId} is already a member of Group ${redashGroupId}`);
        return;
      }
      logger.error(`Failed to add user ${redashUserId} to group ${redashGroupId} in Redash:`, error.message);
      throw new Error(`Redash API addUserToGroup error: ${error.message}`);
    }
  }

  // Remove User from Group
  async removeUserFromGroup(redashUserId: number, redashGroupId: number): Promise<void> {
    if (this.isSimulation) {
      logger.info(`📊 Redash removeUserFromGroup (Simulation): Removed Redash User ID ${redashUserId} from Group ID ${redashGroupId}`);
      return;
    }

    try {
      const client = this.getClient();
      await client.delete(`/api/groups/${redashGroupId}/members/${redashUserId}`);
      logger.info(`📊 Redash: Successfully removed User ${redashUserId} from Group ${redashGroupId}`);
    } catch (error: any) {
      logger.error(`Failed to remove user ${redashUserId} from group ${redashGroupId} in Redash:`, error.message);
      throw new Error(`Redash API removeUserFromGroup error: ${error.message}`);
    }
  }
}

export const redashService = new RedashService();
export default redashService;
