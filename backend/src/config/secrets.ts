import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import dotenv from 'dotenv';
import logger from '../utils/logger';

// Load environment variables from .env file
dotenv.config();

if (process.env.NODE_ENV) {
  process.env.NODE_ENV = process.env.NODE_ENV.replace(/['"]/g, '').trim();
}

let client: SecretsManagerClient | null = null;
const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'local' || process.env.KEYCLOAK_SIMULATION === 'true';

if (!isDev) {
  const requiredEnvVars = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_REGION',
  ];
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

  if (missingVars.length === 0) {
    client = new SecretsManagerClient({
      region: process.env.AWS_REGION as string,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
      },
    });
  } else {
    logger.warn(`Missing AWS variables for Secrets Manager: ${missingVars.join(', ')}. Falling back to local env.`);
  }
}

const secretName = process.env.AWS_SECRET_NAME || 'Atlas-Prod';

export async function getSecret(secretName: string): Promise<string> {
  if (!client) {
    logger.warn('SecretsManagerClient is not initialized. Cannot fetch secrets.');
    return '';
  }

  try {
    const command = new GetSecretValueCommand({
      SecretId: secretName,
    });
    const response = await client.send(command);
    if (response.SecretString) {
      return response.SecretString;
    }
    return '';
  } catch (error) {
    logger.error(
      { error, secretName },
      `Error retrieving secret ${secretName}`,
    );
    throw error;
  }
}

export async function loadSecrets(): Promise<void> {
  if (isDev) {
    logger.info('Running in development mode. Using local variables from .env.');
    return;
  }

  try {
    logger.info('Attempting to fetch secrets from AWS Secrets Manager...');
    const value = await getSecret(secretName);
    if (value) {
      const secretValue = JSON.parse(value);
      Object.entries(secretValue).forEach(([key, val]) => {
        process.env[key] = val as string;
      });
      logger.info(`Successfully loaded and processed secrets from ${secretName}`);
    }
  } catch (error) {
    logger.warn('Failed loading secrets from AWS Secrets Manager. Relying on local env variables.');
  }
}
