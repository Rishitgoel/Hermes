"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.redashService = exports.RedashService = void 0;
const logger_1 = __importDefault(require("../utils/logger"));
const config_1 = __importDefault(require("../config/config"));
const http_client_1 = require("../utils/http-client");
class RedashService {
    baseUrl;
    apiKey;
    isSimulation;
    constructor() {
        this.baseUrl = config_1.default.redash.baseUrl;
        this.apiKey = config_1.default.redash.apiKey;
        this.isSimulation = config_1.default.redash.isSimulation;
    }
    getClient() {
        return (0, http_client_1.createHttpClient)({
            baseURL: this.baseUrl,
            headers: {
                Authorization: `Key ${this.apiKey}`,
                'Content-Type': 'application/json',
            },
        });
    }
    // Sync Users: Fetches all active users from Redash
    async syncUsers() {
        if (this.isSimulation) {
            logger_1.default.info('📊 Redash syncUsers (Simulation): Returning mock users.');
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
            return response.data.results.map((u) => ({
                id: u.id,
                name: u.name,
                email: u.email,
                is_disabled: u.is_disabled,
                is_invitation_pending: !!u.is_invitation_pending,
                // Modern Redash returns `groups` as an array of {id, name} objects;
                // older builds (and the sim shim) return plain integer IDs. Normalize
                // to Int[] so the `RedashUser.groupIds Int[]` column accepts it.
                groups: Array.isArray(u.groups)
                    ? u.groups.map((g) => (typeof g === 'number' ? g : g?.id)).filter((g) => typeof g === 'number')
                    : [],
            }));
        }
        catch (error) {
            logger_1.default.error('Failed to sync users from Redash API:', error.message);
            throw new Error(`Redash API syncUsers error: ${error.message}`);
        }
    }
    // Fetch a single user by email from Redash (Fast-path single sync)
    async fetchUserByEmail(email) {
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
            const u = searchRes.data.results.find((u) => u.email.toLowerCase() === email.toLowerCase());
            if (!u)
                return null;
            return {
                id: u.id,
                name: u.name,
                email: u.email,
                is_disabled: u.is_disabled,
                is_invitation_pending: !!u.is_invitation_pending,
                groups: Array.isArray(u.groups)
                    ? u.groups.map((g) => (typeof g === 'number' ? g : g?.id)).filter((g) => typeof g === 'number')
                    : [],
            };
        }
        catch (error) {
            logger_1.default.error(`Failed to fetch user ${email} from Redash API:`, error.message);
            return null;
        }
    }
    // Sync Groups: Fetches all groups from Redash
    async syncGroups() {
        if (this.isSimulation) {
            logger_1.default.info('📊 Redash syncGroups (Simulation): Returning mock groups.');
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
            return response.data.map((g) => ({
                id: g.id,
                name: g.name,
                type: g.type,
            }));
        }
        catch (error) {
            logger_1.default.error('Failed to sync groups from Redash API:', error.message);
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
    async findOrInviteUser(email, name) {
        if (this.isSimulation) {
            logger_1.default.info(`📊 Redash findOrInviteUser (Simulation): Mocking lookup/invite for ${email}`);
            const lowerEmail = email.toLowerCase();
            // Stable mock IDs for seeded users — and no inviteLink because they already exist.
            if (lowerEmail === 'mayank.aggarwal@bachatt.app')
                return { id: 1 };
            if (lowerEmail === 'yogesh.verma@bachatt.app')
                return { id: 2 };
            if (lowerEmail === 'rishit.goel@bachatt.app')
                return { id: 3 };
            if (lowerEmail === 'ankit.sharma@bachatt.app')
                return { id: 4 };
            // For any other email, simulate a fresh invite — return a fake inviteLink so
            // the rest of the workflow can be exercised end-to-end in sim mode.
            const fakeId = Math.floor(Math.random() * 9000) + 1000;
            const baseUrl = config_1.default.redash.baseUrl?.replace(/\/$/, '') || 'https://redash.bachatt.app';
            const fakeToken = Math.random().toString(36).slice(2, 18);
            return { id: fakeId, inviteLink: `${baseUrl}/invitations/${fakeToken}` };
        }
        try {
            const client = this.getClient();
            // Search user by email
            const searchRes = await client.get(`/api/users?q=${encodeURIComponent(email)}`);
            const existing = searchRes.data.results.find((u) => u.email.toLowerCase() === email.toLowerCase());
            if (existing) {
                logger_1.default.info(`📊 Redash findOrInviteUser: Found existing user ${email} with ID ${existing.id}`);
                // If the user's invitation is pending, generate and return a new invite link
                if (existing.is_invitation_pending) {
                    logger_1.default.info(`📊 Redash findOrInviteUser: Existing user ${email} invitation is pending. Generating new invite link...`);
                    try {
                        const inviteRes = await client.post(`/api/users/${existing.id}/invite`);
                        let inviteLink = typeof inviteRes.data?.invite_link === 'string' ? inviteRes.data.invite_link : undefined;
                        if (inviteLink) {
                            if (inviteLink.startsWith('/')) {
                                const base = this.baseUrl.replace(/\/$/, '');
                                inviteLink = `${base}${inviteLink}`;
                            }
                            else {
                                const parsedUrl = new URL(inviteLink);
                                const configuredUrl = new URL(this.baseUrl);
                                parsedUrl.protocol = configuredUrl.protocol;
                                parsedUrl.host = configuredUrl.host;
                                inviteLink = parsedUrl.toString();
                            }
                        }
                        return { id: existing.id, inviteLink };
                    }
                    catch (inviteErr) {
                        logger_1.default.warn({ email, error: inviteErr.message }, 'Failed to generate invite link for existing pending user; proceeding without it');
                    }
                }
                return { id: existing.id };
            }
            // Create new user (invite). Redash returns `invite_link` in the response body
            // when a fresh invite is created — we capture and surface it inside Hermes.
            logger_1.default.info(`📊 Redash findOrInviteUser: User ${email} not found. Sending invite...`);
            const inviteRes = await client.post('/api/users', {
                name,
                email,
            });
            let inviteLink = typeof inviteRes.data?.invite_link === 'string' ? inviteRes.data.invite_link : undefined;
            if (inviteLink) {
                try {
                    if (inviteLink.startsWith('/')) {
                        const base = this.baseUrl.replace(/\/$/, '');
                        inviteLink = `${base}${inviteLink}`;
                    }
                    else {
                        const parsedUrl = new URL(inviteLink);
                        const configuredUrl = new URL(this.baseUrl);
                        parsedUrl.protocol = configuredUrl.protocol;
                        parsedUrl.host = configuredUrl.host;
                        inviteLink = parsedUrl.toString();
                    }
                }
                catch (err) {
                    logger_1.default.warn({ inviteLink, error: err.message }, 'Failed to normalize invite link URL; using original');
                }
            }
            logger_1.default.info(`📊 Redash findOrInviteUser: Successfully invited user ${email} with ID ${inviteRes.data.id}${inviteLink ? ' (normalized invite link)' : ''}`);
            return { id: inviteRes.data.id, inviteLink };
        }
        catch (error) {
            logger_1.default.error(`Failed to find/invite user ${email} in Redash:`, error.message);
            throw new Error(`Redash API invite error: ${error.message}`);
        }
    }
    // Add User to Group
    async addUserToGroup(redashUserId, redashGroupId) {
        if (this.isSimulation) {
            logger_1.default.info(`📊 Redash addUserToGroup (Simulation): Added Redash User ID ${redashUserId} to Group ID ${redashGroupId}`);
            return;
        }
        try {
            const client = this.getClient();
            await client.post(`/api/groups/${redashGroupId}/members`, {
                user_id: redashUserId,
            });
            logger_1.default.info(`📊 Redash: Successfully added User ${redashUserId} to Group ${redashGroupId}`);
        }
        catch (error) {
            // Check if user is already a member
            if (error.response && error.response.status === 400 && error.response.data?.message?.includes('already a member')) {
                logger_1.default.info(`📊 Redash: User ${redashUserId} is already a member of Group ${redashGroupId}`);
                return;
            }
            logger_1.default.error(`Failed to add user ${redashUserId} to group ${redashGroupId} in Redash:`, error.message);
            throw new Error(`Redash API addUserToGroup error: ${error.message}`);
        }
    }
    // Remove User from Group
    async removeUserFromGroup(redashUserId, redashGroupId) {
        if (this.isSimulation) {
            logger_1.default.info(`📊 Redash removeUserFromGroup (Simulation): Removed Redash User ID ${redashUserId} from Group ID ${redashGroupId}`);
            return;
        }
        try {
            const client = this.getClient();
            await client.delete(`/api/groups/${redashGroupId}/members/${redashUserId}`);
            logger_1.default.info(`📊 Redash: Successfully removed User ${redashUserId} from Group ${redashGroupId}`);
        }
        catch (error) {
            logger_1.default.error(`Failed to remove user ${redashUserId} from group ${redashGroupId} in Redash:`, error.message);
            throw new Error(`Redash API removeUserFromGroup error: ${error.message}`);
        }
    }
}
exports.RedashService = RedashService;
exports.redashService = new RedashService();
exports.default = exports.redashService;
