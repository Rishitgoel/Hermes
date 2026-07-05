import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  ListSecretsCommand,
} from '@aws-sdk/client-secrets-manager';
import config from '../config/config';
import logger from '../utils/logger';
import {
  ValidationError,
  ExternalServiceError,
  NotFoundError,
} from '../utils/errors';

/**
 * In-process, stateful simulation store for testing secret ingestion offline.
 */
interface SimSecret {
  name: string;
  keys: string[];
  values: Record<string, string>;
}

const sim = {
  seeded: false,
  secrets: new Map<string, SimSecret>(),
};

function ensureSimSeeded(): void {
  if (sim.seeded) return;
  sim.seeded = true;
  sim.secrets.set('payment/gateway', {
    name: 'payment/gateway',
    keys: ['STRIPE_API_KEY', 'BRAINTREE_MERCHANT_ID'],
    values: {
      STRIPE_API_KEY: 'sk_test_123456',
      BRAINTREE_MERCHANT_ID: 'merchant_abc123',
    },
  });
  sim.secrets.set('payment/webhook', {
    name: 'payment/webhook',
    keys: ['WEBHOOK_SECRET_KEY'],
    values: {
      WEBHOOK_SECRET_KEY: 'whsec_xyz789',
    },
  });
}

/**
 * A single line in a secrets group's externalGroupId, classified for scope resolution.
 * - `all`    → the literal `*`; matches every secret in the account.
 * - `prefix` → a trailing-`*` pattern (e.g. `investments*`); matches names starting with the prefix.
 * - `exact`  → a concrete secret name (the original, back-compatible form).
 *
 * Wildcard patterns are resolved LIVE against ListSecrets at read time, so newly-created AWS
 * secrets that match are automatically in scope without editing the group.
 */
export type SecretScopePattern =
  | { kind: 'all'; raw: string }
  | { kind: 'prefix'; prefix: string; raw: string }
  | { kind: 'exact'; name: string; raw: string };

export class SecretsManagerService {
  private client: SecretsManagerClient | null = null;

  /** Short-lived cache of the account-wide secret list, to avoid a ListSecrets call per request. */
  private allSecretsCache: { names: string[]; expiresAt: number } | null = null;
  private static readonly ALL_SECRETS_TTL_MS = 30_000;

  private get isSimulation(): boolean {
    return config.secrets.isSimulation;
  }

  private getClient(): SecretsManagerClient {
    if (this.client) return this.client;
    const region = config.secrets.region;
    if (!region) {
      throw new ExternalServiceError('AWS region for Secrets Manager is not configured');
    }
    const accessKeyId = config.aws.accessKeyId;
    const secretAccessKey = config.aws.secretAccessKey;

    this.client = new SecretsManagerClient({
      region,
      maxAttempts: 6,
      retryMode: 'adaptive',
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });
    return this.client;
  }

  private mapAwsError(err: any, op: string): never {
    const name: string | undefined = err?.name;
    const msg = err?.message || String(err);
    const ctx = { op, awsErrorName: name };
    if (name === 'ResourceNotFoundException') {
      throw new NotFoundError(`Secret not found during ${op}: ${msg}`, ctx);
    }
    if (name === 'InvalidRequestException' || name === 'ValidationException') {
      throw new ValidationError(`Secrets Manager rejected ${op}: ${msg}`, ctx);
    }
    throw new ExternalServiceError(`Secrets Manager error during ${op}: ${msg}`, ctx);
  }

  /**
   * Parse newline-separated secret names from a group's externalGroupId.
   */
  parseSecretNames(externalGroupId: string): string[] {
    const names = new Set<string>();
    for (const line of (externalGroupId || '').split(/\r?\n/)) {
      const name = line.trim();
      if (name) {
        names.add(name);
      }
    }
    if (names.size === 0) {
      throw new ValidationError(
        `Invalid Secret Ingestion group id "${externalGroupId}" — expected at least one AWS secret name, one per line.`,
      );
    }
    return [...names];
  }

  /**
   * Parse a group's externalGroupId into scope patterns (exact names and/or wildcards).
   * `*` = every secret; `prefix*` = names starting with `prefix`; anything else = an exact name.
   */
  parseScopePatterns(externalGroupId: string): SecretScopePattern[] {
    const patterns: SecretScopePattern[] = [];
    const seen = new Set<string>();
    for (const line of (externalGroupId || '').split(/\r?\n/)) {
      const raw = line.trim();
      if (!raw || seen.has(raw)) {
        continue;
      }
      seen.add(raw);
      if (raw === '*') {
        patterns.push({ kind: 'all', raw });
      } else if (raw.endsWith('*')) {
        patterns.push({ kind: 'prefix', prefix: raw.slice(0, -1), raw });
      } else {
        patterns.push({ kind: 'exact', name: raw, raw });
      }
    }
    if (patterns.length === 0) {
      throw new ValidationError(
        `Invalid Secret Ingestion group id "${externalGroupId}" — expected at least one AWS secret name or wildcard pattern, one per line.`,
      );
    }
    return patterns;
  }

  /** Whether a resolved secret name is covered by a scope pattern (case-insensitive). */
  matchesPattern(pattern: SecretScopePattern, secretName: string): boolean {
    const name = secretName.toLowerCase();
    switch (pattern.kind) {
      case 'all':
        return true;
      case 'prefix':
        return name.startsWith(pattern.prefix.toLowerCase());
      case 'exact':
        return pattern.name.toLowerCase() === name;
    }
  }

  /**
   * List the existing key names for a secret (masking/omitting values).
   */
  async listSecretKeys(name: string): Promise<{ exists: boolean; keys: string[] }> {
    if (this.isSimulation) {
      ensureSimSeeded();
      const secret = sim.secrets.get(name);
      if (!secret) {
        return { exists: false, keys: [] };
      }
      return { exists: true, keys: secret.keys };
    }

    try {
      const client = this.getClient();
      const command = new GetSecretValueCommand({ SecretId: name });
      const res = await client.send(command);
      if (!res.SecretString) {
        return { exists: true, keys: [] };
      }
      const data = JSON.parse(res.SecretString);
      return { exists: true, keys: Object.keys(data) };
    } catch (err: any) {
      if (err.name === 'ResourceNotFoundException') {
        return { exists: false, keys: [] };
      }
      logger.error({ err, secretName: name }, `Failed to list secret keys for ${name}`);
      throw this.mapAwsError(err, `Failed to list secret keys for ${name}`);
    }
  }

  /**
   * Internal helper to fetch the raw key-value map of a secret.
   * Returns null if the secret does not exist.
   */
  async getSecretMap(name: string): Promise<Record<string, string> | null> {
    if (this.isSimulation) {
      ensureSimSeeded();
      const secret = sim.secrets.get(name);
      if (!secret) {
        return null;
      }
      return { ...secret.values };
    }

    try {
      const client = this.getClient();
      const command = new GetSecretValueCommand({ SecretId: name });
      const res = await client.send(command);
      if (!res.SecretString) {
        return {};
      }
      return JSON.parse(res.SecretString);
    } catch (err: any) {
      if (err.name === 'ResourceNotFoundException') {
        return null;
      }
      logger.error({ err, secretName: name }, `Failed to fetch secret map for ${name}`);
      throw this.mapAwsError(err, `Failed to fetch secret map for ${name}`);
    }
  }

  /**
   * Merges and writes the key-value pairs to the secret.
   */
  async putSecretKeyValues(
    name: string,
    kv: Record<string, string>,
    opts: { createIfMissing: boolean }
  ): Promise<void> {
    if (this.isSimulation) {
      ensureSimSeeded();
      let secret = sim.secrets.get(name);
      if (!secret) {
        if (!opts.createIfMissing) {
          throw new NotFoundError(`Secret ${name} not found in simulation store`);
        }
        secret = {
          name,
          keys: [],
          values: {},
        };
        sim.secrets.set(name, secret);
      }
      // Merge values
      for (const [k, v] of Object.entries(kv)) {
        secret.values[k] = v;
      }
      secret.keys = Object.keys(secret.values);
      return;
    }

    // Live mode
    const client = this.getClient();
    let currentMap: Record<string, string> = {};
    let exists = true;
    try {
      const getCommand = new GetSecretValueCommand({ SecretId: name });
      const getRes = await client.send(getCommand);
      if (getRes.SecretString) {
        currentMap = JSON.parse(getRes.SecretString);
      }
    } catch (err: any) {
      if (err.name === 'ResourceNotFoundException') {
        exists = false;
        if (!opts.createIfMissing) {
          throw new NotFoundError(`Secret ${name} not found`);
        }
      } else {
        throw this.mapAwsError(err, `Failed to retrieve secret ${name} before merge`);
      }
    }

    const mergedMap = { ...currentMap, ...kv };
    const secretString = JSON.stringify(mergedMap);

    try {
      if (exists) {
        const putCommand = new PutSecretValueCommand({
          SecretId: name,
          SecretString: secretString,
        });
        await client.send(putCommand);
      } else {
        const createCommand = new CreateSecretCommand({
          Name: name,
          SecretString: secretString,
        });
        await client.send(createCommand);
        // A brand-new secret just came into existence — drop the cached list so wildcard
        // scopes surface it on the next read instead of waiting out the TTL.
        this.allSecretsCache = null;
      }
    } catch (err: any) {
      throw this.mapAwsError(err, `Failed to write secret ${name}`);
    }
  }

  /**
   * List all secrets in the AWS account.
   */
  async listAllAwsSecrets(): Promise<string[]> {
    if (this.isSimulation) {
      ensureSimSeeded();
      return [
        ...sim.secrets.keys(),
        'prod/database',
        'prod/redis',
        'staging/database',
        'staging/redis',
        'analytics/mixpanel',
        'common/api-keys',
      ].sort();
    }

    const now = Date.now();
    if (this.allSecretsCache && this.allSecretsCache.expiresAt > now) {
      return this.allSecretsCache.names;
    }

    try {
      const client = this.getClient();
      const secretNames: string[] = [];
      let nextToken: string | undefined;

      do {
        const command = new ListSecretsCommand({
          NextToken: nextToken,
          MaxResults: 100,
        });
        const res = await client.send(command);
        if (res.SecretList) {
          for (const sec of res.SecretList) {
            if (sec.Name) {
              secretNames.push(sec.Name);
            }
          }
        }
        nextToken = res.NextToken;
      } while (nextToken);

      const sorted = secretNames.sort();
      this.allSecretsCache = {
        names: sorted,
        expiresAt: now + SecretsManagerService.ALL_SECRETS_TTL_MS,
      };
      return sorted;
    } catch (err: any) {
      logger.error({ err }, 'Failed to list all AWS secrets');
      throw this.mapAwsError(err, 'Failed to list all AWS secrets');
    }
  }

  /**
   * Liveness healthcheck.
   */
  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (this.isSimulation) {
      return { healthy: true, message: 'simulation' };
    }
    try {
      await this.getClient().send(new ListSecretsCommand({ MaxResults: 1 }));
      return { healthy: true };
    } catch (err: any) {
      return { healthy: false, message: err?.message || String(err) };
    }
  }

  /**
   * Reset simulation store (for testing only)
   */
  __resetSim(): void {
    sim.seeded = true;
    sim.secrets.clear();
    this.allSecretsCache = null;
  }
}

export const secretsManagerService = new SecretsManagerService();
export default secretsManagerService;
