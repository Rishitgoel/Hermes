import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import config from './config';
import logger from '../utils/logger';

let client: SecretsManagerClient | null = null;
const isDev = config.isDev || config.isSimulation;

if (!isDev) {
  const { region, accessKeyId, secretAccessKey } = config.aws;
  const missingVars = [
    !accessKeyId && 'AWS_ACCESS_KEY_ID',
    !secretAccessKey && 'AWS_SECRET_ACCESS_KEY',
    !region && 'AWS_REGION',
  ].filter(Boolean);

  if (missingVars.length === 0) {
    client = new SecretsManagerClient({
      region: region!,
      credentials: {
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
      },
    });
  } else {
    logger.warn(`Missing AWS variables for Secrets Manager: ${missingVars.join(', ')}. Falling back to local env.`);
  }
}

export async function getSecret(name: string): Promise<string> {
  if (!client) {
    logger.warn('SecretsManagerClient is not initialized. Cannot fetch secrets.');
    return '';
  }

  try {
    const command = new GetSecretValueCommand({
      SecretId: name,
    });
    const response = await client.send(command);
    if (response.SecretString) {
      return response.SecretString;
    }
    return '';
  } catch (error) {
    logger.error(
      { error, secretName: name },
      `Error retrieving secret ${name}`,
    );
    throw error;
  }
}

export async function loadSecrets(): Promise<void> {
  if (isDev) {
    logger.info('Running in development/simulation mode. Using local variables from .env.');
    return;
  }

  try {
    logger.info('Attempting to fetch secrets from AWS Secrets Manager...');
    const value = await getSecret(config.aws.secretName);
    if (value) {
      const secretValue = JSON.parse(value);
      Object.entries(secretValue).forEach(([key, val]) => {
        process.env[key] = val as string;
      });
      logger.info(`Successfully loaded and processed secrets from ${config.aws.secretName}`);
    }
  } catch (error) {
    logger.warn('Failed loading secrets from AWS Secrets Manager. Relying on local env variables.');
  }
}
