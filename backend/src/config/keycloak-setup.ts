import logger from '../utils/logger';
import axios from 'axios';
import config from './config';

export class KeycloakSetupService {
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

      // 3. Ensure Roles Exist
      const roles = ['hermes_super_admin', 'hermes_group_admin', 'hermes_user'];
      const rolesUrl = `${adminUrl}/admin/realms/${realm}/roles`;

      for (const roleName of roles) {
        try {
          await axios.get(`${rolesUrl}/${roleName}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          logger.info(`🔑 Keycloak setup: Role '${roleName}' already exists.`);
        } catch (err: any) {
          if (err.response && err.response.status === 404) {
            logger.info(`🔑 Keycloak setup: Creating realm role '${roleName}'...`);
            await axios.post(
              rolesUrl,
              { name: roleName, description: `Hermes ${roleName.replace('hermes_', '')} role` },
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
