"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSecret = getSecret;
exports.loadSecrets = loadSecrets;
const client_secrets_manager_1 = require("@aws-sdk/client-secrets-manager");
const config_1 = __importDefault(require("./config"));
const logger_1 = __importDefault(require("../utils/logger"));
let client = null;
const isDev = config_1.default.isDev || config_1.default.isSimulation;
if (!isDev) {
    const { region, accessKeyId, secretAccessKey } = config_1.default.aws;
    const missingVars = [
        !accessKeyId && 'AWS_ACCESS_KEY_ID',
        !secretAccessKey && 'AWS_SECRET_ACCESS_KEY',
        !region && 'AWS_REGION',
    ].filter(Boolean);
    if (missingVars.length === 0) {
        client = new client_secrets_manager_1.SecretsManagerClient({
            region: region,
            credentials: {
                accessKeyId: accessKeyId,
                secretAccessKey: secretAccessKey,
            },
        });
    }
    else {
        logger_1.default.warn(`Missing AWS variables for Secrets Manager: ${missingVars.join(', ')}. Falling back to local env.`);
    }
}
async function getSecret(name) {
    if (!client) {
        logger_1.default.warn('SecretsManagerClient is not initialized. Cannot fetch secrets.');
        return '';
    }
    try {
        const command = new client_secrets_manager_1.GetSecretValueCommand({
            SecretId: name,
        });
        const response = await client.send(command);
        if (response.SecretString) {
            return response.SecretString;
        }
        return '';
    }
    catch (error) {
        logger_1.default.error({ error, secretName: name }, `Error retrieving secret ${name}`);
        throw error;
    }
}
async function loadSecrets() {
    if (isDev) {
        logger_1.default.info('Running in development/simulation mode. Using local variables from .env.');
        return;
    }
    try {
        logger_1.default.info('Attempting to fetch secrets from AWS Secrets Manager...');
        const value = await getSecret(config_1.default.aws.secretName);
        if (value) {
            const secretValue = JSON.parse(value);
            Object.entries(secretValue).forEach(([key, val]) => {
                process.env[key] = val;
            });
            logger_1.default.info(`Successfully loaded and processed secrets from ${config_1.default.aws.secretName}`);
        }
    }
    catch (error) {
        logger_1.default.warn('Failed loading secrets from AWS Secrets Manager. Relying on local env variables.');
    }
}
