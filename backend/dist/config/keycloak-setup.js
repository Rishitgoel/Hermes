"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.keycloakSetupService = exports.KeycloakSetupService = void 0;
const logger_1 = __importDefault(require("../utils/logger"));
const axios_1 = __importDefault(require("axios"));
const config_1 = __importDefault(require("./config"));
class KeycloakSetupService {
    async ensureClientAndRolesExist() {
        if (config_1.default.isSimulation || !config_1.default.keycloak.adminPassword) {
            logger_1.default.info('🔑 Keycloak setup: Running in SIMULATION mode. Auto-configuring atlas-prod client and roles locally in memory.');
            return;
        }
        try {
            logger_1.default.info('🔑 Keycloak setup: Contacting Keycloak Admin API to check client and roles...');
            const adminUrl = config_1.default.keycloak.adminUrl;
            const realm = config_1.default.keycloak.realm;
            const clientId = config_1.default.keycloak.adminClientId;
            const username = config_1.default.keycloak.adminUsername;
            const password = config_1.default.keycloak.adminPassword;
            // 1. Get Admin Access Token
            const tokenUrl = `${adminUrl}/realms/${realm}/protocol/openid-connect/token`;
            const tokenRes = await axios_1.default.post(tokenUrl, new URLSearchParams({
                grant_type: 'password',
                client_id: clientId,
                username,
                password: password || '',
            }).toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            });
            const accessToken = tokenRes.data.access_token;
            logger_1.default.info('🔑 Keycloak setup: Authenticated with Keycloak Admin API.');
            // 2. Check if client 'atlas-prod' exists
            const targetClientId = config_1.default.keycloak.audience || 'atlas-prod';
            const clientsUrl = `${adminUrl}/admin/realms/${realm}/clients`;
            const clientsRes = await axios_1.default.get(clientsUrl, {
                headers: { Authorization: `Bearer ${accessToken}` },
                params: { clientId: targetClientId },
            });
            let clientDbId = '';
            const existingClient = clientsRes.data.find((c) => c.clientId === targetClientId);
            if (existingClient) {
                clientDbId = existingClient.id;
                logger_1.default.info(`🔑 Keycloak setup: Client '${targetClientId}' already exists.`);
            }
            else {
                // Create Client
                logger_1.default.info(`🔑 Keycloak setup: Client '${targetClientId}' not found. Creating...`);
                const createRes = await axios_1.default.post(clientsUrl, {
                    clientId: targetClientId,
                    enabled: true,
                    publicClient: true,
                    directAccessGrantsEnabled: true,
                    standardFlowEnabled: true,
                    redirectUris: [
                        'https://atlas.bachatt.app/*',
                        'http://localhost:5173/*',
                        'http://localhost:5174/*',
                    ],
                    webOrigins: ['+'],
                }, {
                    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                });
                logger_1.default.info(`🔑 Keycloak setup: Client '${targetClientId}' created successfully.`);
                // Fetch to get ID
                const recheckRes = await axios_1.default.get(clientsUrl, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                    params: { clientId: targetClientId },
                });
                clientDbId = recheckRes.data.find((c) => c.clientId === targetClientId)?.id || '';
            }
            // 3. Ensure Roles Exist
            const roles = ['atlas_super_admin', 'atlas_group_admin', 'atlas_user'];
            const rolesUrl = `${adminUrl}/admin/realms/${realm}/roles`;
            for (const roleName of roles) {
                try {
                    await axios_1.default.get(`${rolesUrl}/${roleName}`, {
                        headers: { Authorization: `Bearer ${accessToken}` },
                    });
                    logger_1.default.info(`🔑 Keycloak setup: Role '${roleName}' already exists.`);
                }
                catch (err) {
                    if (err.response && err.response.status === 404) {
                        logger_1.default.info(`🔑 Keycloak setup: Creating realm role '${roleName}'...`);
                        await axios_1.default.post(rolesUrl, { name: roleName, description: `Atlas ${roleName.replace('atlas_', '')} role` }, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } });
                        logger_1.default.info(`🔑 Keycloak setup: Role '${roleName}' created.`);
                    }
                    else {
                        throw err;
                    }
                }
            }
            logger_1.default.info('🔑 Keycloak setup: Configuration complete.');
        }
        catch (error) {
            logger_1.default.error('🔑 Keycloak setup failed: ' + (error.response?.data?.error_description || error.message));
            // In development, do not crash if Keycloak is unavailable, fallback to simulation
            if (config_1.default.isDev) {
                logger_1.default.warn('🔑 Keycloak setup failed in development environment. Continuing with startup...');
            }
            else {
                throw error;
            }
        }
    }
}
exports.KeycloakSetupService = KeycloakSetupService;
exports.keycloakSetupService = new KeycloakSetupService();
exports.default = exports.keycloakSetupService;
