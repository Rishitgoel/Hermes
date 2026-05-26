import logger from '../utils/logger';
import config from '../config/config';
import { createHttpClient } from '../utils/http-client';

export interface RedashUserResponse {
  id: number;
  name: string;
  email: string;
  is_disabled: boolean;
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
        { id: 1, name: 'Mayank Aggarwal', email: 'mayank.aggarwal@bachatt.app', is_disabled: false, groups: [1, 2] },
        { id: 2, name: 'Yogesh Verma', email: 'yogesh.verma@bachatt.app', is_disabled: false, groups: [1, 101] },
        { id: 3, name: 'Rishit Goel', email: 'rishit.goel@bachatt.app', is_disabled: false, groups: [1] },
        { id: 4, name: 'Ankit Sharma', email: 'ankit.sharma@bachatt.app', is_disabled: false, groups: [1, 2] },
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
        groups: u.groups || [],
      }));
    } catch (error: any) {
      logger.error('Failed to sync users from Redash API:', error.message);
      throw new Error(`Redash API syncUsers error: ${error.message}`);
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

  // Find or Invite User: Checks if email exists, if not, creates/invites user in Redash. Returns Redash user ID.
  async findOrInviteUser(email: string, name: string): Promise<number> {
    if (this.isSimulation) {
      logger.info(`📊 Redash findOrInviteUser (Simulation): Mocking lookup/invite for ${email}`);
      const lowerEmail = email.toLowerCase();
      // Return a stable mock ID based on the email
      if (lowerEmail === 'mayank.aggarwal@bachatt.app') return 1;
      if (lowerEmail === 'yogesh.verma@bachatt.app') return 2;
      if (lowerEmail === 'rishit.goel@bachatt.app') return 3;
      if (lowerEmail === 'ankit.sharma@bachatt.app') return 4;
      return Math.floor(Math.random() * 9000) + 1000;
    }

    try {
      const client = this.getClient();
      // Search user by email
      const searchRes = await client.get(`/api/users?q=${encodeURIComponent(email)}`);
      const existing = searchRes.data.results.find((u: any) => u.email.toLowerCase() === email.toLowerCase());

      if (existing) {
        logger.info(`📊 Redash findOrInviteUser: Found existing user ${email} with ID ${existing.id}`);
        return existing.id;
      }

      // Create new user (invite)
      logger.info(`📊 Redash findOrInviteUser: User ${email} not found. Sending invite...`);
      const inviteRes = await client.post('/api/users', {
        name,
        email,
      });
      logger.info(`📊 Redash findOrInviteUser: Successfully invited user ${email} with ID ${inviteRes.data.id}`);
      return inviteRes.data.id;
    } catch (error: any) {
      logger.error(`Failed to find/invite user ${email} in Redash:`, error.message);
      throw new Error(`Redash API invite error: ${error.message}`);
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
