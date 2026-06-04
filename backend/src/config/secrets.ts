import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import config from './config';
import logger from '../utils/logger';

let client: SecretsManagerClient | null = null;
const isDev = config.isDev || config.isSimulation;

if (!isDev) {
  // Use the AWS SDK's default credential provider chain — do NOT pass explicit
  // long-lived keys. On AWS we authenticate with the ECS/EKS task role or EC2
  // instance role (the chain resolves them automatically), and it still picks up
  // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from env for local testing. Region
  // falls back to the SDK's own resolution (AWS_REGION) when not set in config.
  client = new SecretsManagerClient(
    config.aws.region ? { region: config.aws.region } : {},
  );
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
    if (!value) {
      throw new Error(`Secret "${config.aws.secretName}" was empty or not found`);
    }
    const secretValue = JSON.parse(value);
    Object.entries(secretValue).forEach(([key, val]) => {
      process.env[key] = val as string;
    });
    logger.info(`Successfully loaded and processed secrets from ${config.aws.secretName}`);
  } catch (error: any) {
    // Fail CLOSED outside dev/sim: a secrets failure would otherwise fall back to
    // local/default env (e.g. the Redash dummy key → silent simulation in prod, or
    // an unauthenticated DB). Crash startup instead of running degraded/insecure.
    logger.fatal(`Failed loading secrets from AWS Secrets Manager: ${error.message}`);
    throw error;
  }
}
