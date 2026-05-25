"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSecret = getSecret;
exports.loadSecrets = loadSecrets;
const client_secrets_manager_1 = require("@aws-sdk/client-secrets-manager");
const dotenv_1 = __importDefault(require("dotenv"));
const logger_1 = __importDefault(require("../utils/logger"));
// Load environment variables from .env file
dotenv_1.default.config();
if (process.env.NODE_ENV) {
    process.env.NODE_ENV = process.env.NODE_ENV.replace(/['"]/g, '').trim();
}
let client = null;
const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'local' || process.env.KEYCLOAK_SIMULATION === 'true';
if (!isDev) {
    const requiredEnvVars = [
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_REGION',
    ];
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    if (missingVars.length === 0) {
        client = new client_secrets_manager_1.SecretsManagerClient({
            region: process.env.AWS_REGION,
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
        });
    }
    else {
        logger_1.default.warn(`Missing AWS variables for Secrets Manager: ${missingVars.join(', ')}. Falling back to local env.`);
    }
}
const secretName = process.env.AWS_SECRET_NAME || 'Atlas-Prod';
async function getSecret(secretName) {
    if (!client) {
        logger_1.default.warn('SecretsManagerClient is not initialized. Cannot fetch secrets.');
        return '';
    }
    try {
        const command = new client_secrets_manager_1.GetSecretValueCommand({
            SecretId: secretName,
        });
        const response = await client.send(command);
        if (response.SecretString) {
            return response.SecretString;
        }
        return '';
    }
    catch (error) {
        logger_1.default.error({ error, secretName }, `Error retrieving secret ${secretName}`);
        throw error;
    }
}
async function loadSecrets() {
    if (isDev) {
        logger_1.default.info('Running in development mode. Using local variables from .env.');
        return;
    }
    try {
        logger_1.default.info('Attempting to fetch secrets from AWS Secrets Manager...');
        const value = await getSecret(secretName);
        if (value) {
            const secretValue = JSON.parse(value);
            Object.entries(secretValue).forEach(([key, val]) => {
                process.env[key] = val;
            });
            logger_1.default.info(`Successfully loaded and processed secrets from ${secretName}`);
        }
    }
    catch (error) {
        logger_1.default.warn('Failed loading secrets from AWS Secrets Manager. Relying on local env variables.');
    }
}
