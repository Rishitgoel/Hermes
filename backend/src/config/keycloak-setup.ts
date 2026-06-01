import logger from '../utils/logger';
import axios from 'axios';
import config from './config';

const SUPER_ADMIN_ROLE = 'hermes_super_admin';

// Sim-mode identity for the super-admin user. Mirrors checkJwtSimulated in
// auth.middleware.ts so notifications fan out to the right local user.
const SIM_SUPER_ADMIN_USER_ID = 'super-admin-uuid-1111';

export class KeycloakSetupService {
  private async getAdminAccessToken(): Promise<string | null> {
    try {
      const tokenUrl = `${config.keycloak.adminUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/token`;
      const res = await axios.post(
        tokenUrl,
        new URLSearchParams({
          grant_type: 'password',
          client_id: config.keycloak.adminClientId,
          username: config.keycloak.adminUsername,
          password: config.keycloak.adminPassword || '',
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      return res.data.access_token;
    } catch (err: any) {
      logger.warn(`Failed to obtain Keycloak admin token: ${err.message}`);
      return null;
    }
  }

  /**
   * Returns every user holding the realm role `hermes_super_admin`, with their
   * Keycloak ID and (when available) email. In simulation mode — or when
   * Keycloak isn't reachable — returns the sim super-admin so notifications
   * still fan out locally. The sim email comes from SIM_ADMIN_EMAIL (optional).
   */
  async getSuperAdmins(): Promise<Array<{ id: string; email?: string }>> {
    if (config.isSimulation || !config.keycloak.adminPassword) {
      return [{ id: SIM_SUPER_ADMIN_USER_ID, email: config.email.simAdminEmail }];
    }

    const accessToken = await this.getAdminAccessToken();
    if (!accessToken) return [];

    try {
      const url = `${config.keycloak.adminUrl}/admin/realms/${config.keycloak.realm}/roles/${SUPER_ADMIN_ROLE}/users`;
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { max: 200 },
      });
      const users: any[] = Array.isArray(res.data) ? res.data : [];
      return users
        .filter((u) => typeof u.id === 'string')
        .map((u) => ({ id: u.id as string, email: typeof u.email === 'string' ? u.email : undefined }));
    } catch (err: any) {
      logger.warn(`Failed to fetch super-admin users from Keycloak: ${err.message}`);
      return [];
    }
  }

  async ensureClientAndRolesExist(): Promise<void> {
    if (config.isSimulation || !config.keycloak.adminPassword) {
      logger.info('🔑 Keycloak setup: Running in SIMULATION mode. Auto-configuring hermes-prod client and roles locally in memory.');
      return;
    }

    try {
      logger.info('🔑 Keycloak setup: Contacting Keycloak Admin API to check client and roles...');

      const adminUrl = config.keycloak.adminUrl;
      const realm = config.keycloak.realm;
      const clientId = config.keycloak.adminClientId;
      const username = config.keycloak.adminUsername;
      const password = config.keycloak.adminPassword;

      // 1. Get Admin Access Token
      const tokenUrl = `${adminUrl}/realms/${realm}/protocol/openid-connect/token`;
      const tokenRes = await axios.post(
        tokenUrl,
        new URLSearchParams({
          grant_type: 'password',
          client_id: clientId,
          username,
          password: password || '',
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }
      );

      const accessToken = tokenRes.data.access_token;
      logger.info('🔑 Keycloak setup: Authenticated with Keycloak Admin API.');

      // 2. Check if client 'hermes-prod' exists
      const targetClientId = config.keycloak.audience || 'hermes-prod';
      const clientsUrl = `${adminUrl}/admin/realms/${realm}/clients`;
      const clientsRes = await axios.get(clientsUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { clientId: targetClientId },
      });

      let clientDbId = '';
      const existingClient = clientsRes.data.find((c: any) => c.clientId === targetClientId);

      if (existingClient) {
        clientDbId = existingClient.id;
        logger.info(`🔑 Keycloak setup: Client '${targetClientId}' already exists.`);
      } else {
        // Create Client
        logger.info(`🔑 Keycloak setup: Client '${targetClientId}' not found. Creating...`);
        const createRes = await axios.post(
          clientsUrl,
          {
            clientId: targetClientId,
            enabled: true,
            publicClient: true,
            directAccessGrantsEnabled: true,
            standardFlowEnabled: true,
            redirectUris: [
              'https://hermes.bachatt.app/*',
              'http://localhost:5173/*',
              'http://localhost:5174/*',
            ],
            webOrigins: ['+'],
          },
          {
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          }
        );
        logger.info(`🔑 Keycloak setup: Client '${targetClientId}' created successfully.`);
        
        // Fetch to get ID
        const recheckRes = await axios.get(clientsUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { clientId: targetClientId },
        });
        clientDbId = recheckRes.data.find((c: any) => c.clientId === targetClientId)?.id || '';
      }

      // 3. Ensure Roles Exist (idempotent: create if missing, else keep the
      //    description in sync). These are the blanket markers; the scoped roles
      //    (hermes_platform_admin_<platform>, hermes_group_admin_<platform>_<slug>)
      //    are created on demand by keycloak-admin.service as composites of them.
      //    The marker descriptions spell out that they aren't assigned directly,
      //    so they don't look like assignable roles in the Keycloak console.
      const roleDefs: Record<string, string> = {
        hermes_super_admin:
          'Hermes super admin — full access across all platforms. Assign this manually in Keycloak; it is the only Hermes role set by hand.',
        hermes_platform_admin:
          'Marker only — do NOT assign directly. Carried automatically via hermes_platform_admin_<platform> composite roles, which Hermes creates when you assign a platform admin.',
        hermes_group_admin:
          'Marker only — do NOT assign directly. Carried automatically via hermes_group_admin_<platform>_<slug> composite roles, which Hermes creates when you assign a group admin.',
        hermes_user: 'Hermes base user role (default for every authenticated user).',
      };
      const rolesUrl = `${adminUrl}/admin/realms/${realm}/roles`;

      for (const [roleName, description] of Object.entries(roleDefs)) {
        try {
          const existing = await axios.get(`${rolesUrl}/${encodeURIComponent(roleName)}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          // Self-heal the description for realms created before it was clarified.
          // Spread the existing rep so composite/other fields are preserved.
          if (existing.data?.description !== description) {
            await axios.put(
              `${rolesUrl}/${encodeURIComponent(roleName)}`,
              { ...existing.data, description },
              { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
            );
            logger.info(`🔑 Keycloak setup: Updated description for role '${roleName}'.`);
          } else {
            logger.info(`🔑 Keycloak setup: Role '${roleName}' already up to date.`);
          }
        } catch (err: any) {
          if (err.response && err.response.status === 404) {
            logger.info(`🔑 Keycloak setup: Creating realm role '${roleName}'...`);
            await axios.post(
              rolesUrl,
              { name: roleName, description },
              { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
            );
            logger.info(`🔑 Keycloak setup: Role '${roleName}' created.`);
          } else {
            throw err;
          }
        }
      }

      logger.info('🔑 Keycloak setup: Configuration complete.');
    } catch (error: any) {
      logger.error('🔑 Keycloak setup failed: ' + (error.response?.data?.error_description || error.message));
      // In development, do not crash if Keycloak is unavailable, fallback to simulation
      if (config.isDev) {
        logger.warn('🔑 Keycloak setup failed in development environment. Continuing with startup...');
      } else {
        throw error;
      }
    }
  }
}

export const keycloakSetupService = new KeycloakSetupService();
export default keycloakSetupService;
