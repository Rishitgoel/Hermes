import logger from '../utils/logger';
import axios from 'axios';

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
    this.baseUrl = process.env.REDASH_BASE_URL || 'https://redash.bachatt.app';
    this.apiKey = process.env.REDASH_API_KEY || 'dummy-key-for-development';
    this.isSimulation =
      process.env.REDASH_SIMULATION === 'true' ||
      this.apiKey === 'dummy-key-for-development' ||
      process.env.NODE_ENV === 'development';
  }

  private getClient() {
    return axios.create({
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
        { id: 1, name: 'Ankit Sharma', email: 'ankit@bachatt.com', is_disabled: false, groups: [1, 2] },
        { id: 2, name: 'Rishi Bachatt', email: 'rishi@bachatt.com', is_disabled: false, groups: [1, 3] },
        { id: 3, name: 'Growth Lead', email: 'lead@bachatt.com', is_disabled: false, groups: [1, 101] },
        { id: 4, name: 'Regular Employee', email: 'employee@bachatt.com', is_disabled: false, groups: [1] },
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
      // Return a stable mock ID based on the email
      if (email === 'admin@bachatt.com') return 1;
      if (email === 'lead@bachatt.com') return 3;
      if (email === 'employee@bachatt.com') return 4;
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

  // Disable User
  async disableUser(redashUserId: number): Promise<void> {
    if (this.isSimulation) {
      logger.info(`📊 Redash disableUser (Simulation): Disabled Redash User ID ${redashUserId}`);
      return;
    }

    try {
      const client = this.getClient();
      await client.delete(`/api/users/${redashUserId}`);
      logger.info(`📊 Redash: Successfully disabled User ${redashUserId}`);
    } catch (error: any) {
      logger.error(`Failed to disable user ${redashUserId} in Redash:`, error.message);
      throw new Error(`Redash API disableUser error: ${error.message}`);
    }
  }
}

export const redashService = new RedashService();
export default redashService;
