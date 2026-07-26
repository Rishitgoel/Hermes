import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  ListSecretsCommand,
} from '@aws-sdk/client-secrets-manager';
import { chain, memoize } from '@smithy/property-provider';
import { fromSSO } from '@aws-sdk/credential-provider-sso';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { fromProcess } from '@aws-sdk/credential-provider-process';
import { fromTokenFile } from '@aws-sdk/credential-provider-web-identity';
import { fromHttp } from '@aws-sdk/credential-provider-http';
import { fromContainerMetadata, fromInstanceMetadata } from '@smithy/credential-provider-imds';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Agent as HttpsAgent } from 'https';
import config from '../config/config';
import logger from '../utils/logger';
import {
  ValidationError,
  ExternalServiceError,
  NotFoundError,
} from '../utils/errors';
import {
  SecretStore,
  SecretsInstanceConfig,
  SecretScopePattern,
  parseSecretNames as sharedParseSecretNames,
  parseScopePatterns as sharedParseScopePatterns,
  matchesPattern as sharedMatchesPattern,
} from './secret-store.interface';
import { KeyVaultService } from './key-vault.service';

/**
 * In-process, stateful simulation store for testing secret ingestion offline.
 * One store per SecretsManagerService instance (prod vs sandbox), so the two
 * simulated AWS accounts never share secrets.
 */
interface SimSecret {
  name: string;
  keys: string[];
  values: Record<string, string>;
}

// The instance-config and scope-pattern types now live in secret-store.interface.ts so the Azure
// store can share them without importing this module. Re-exported here because existing callers
// (secret-ingestion.service.ts, the provisioner, tests) import them from this path.
export type {
  SecretsInstanceConfig,
  SecretScopePattern,
  SecretStore,
} from './secret-store.interface';

/** Fixed extra secret names each simulated instance surfaces from listAllAwsSecrets (beyond the seeded ones). */
const SIM_EXTRA_SECRETS: Record<string, string[]> = {
  secrets: [
    'prod/database',
    'prod/redis',
    'staging/database',
    'staging/redis',
    'analytics/mixpanel',
    'common/api-keys',
  ],
  'secrets-sandbox': [
    'sandbox/database',
    'sandbox/redis',
    'sandbox/feature-flags',
    'sandbox/common/api-keys',
  ],
};

/**
 * Custom credential provider for a Secrets Manager Client.
 * Prioritizes dedicated credentials (accessKeyId + secretAccessKey) when supplied — prod passes
 * Hermes' own AWS keys here. Otherwise falls back to the standard AWS SDK provider chain but
 * EXCLUDES the environment provider (fromEnv) to avoid clashing with Apollo's credentials; the
 * sandbox instance takes this path (SDK default chain only), optionally scoped to `profile` so it
 * can resolve a *different* AWS account than prod.
 */
export function getSecretsManagerProvider(
  creds: { accessKeyId?: string; secretAccessKey?: string; profile?: string } = {},
  baseInit: any = {},
): () => Promise<any> {
  const { accessKeyId, secretAccessKey, profile } = creds;

  // If dedicated credentials are supplied, prioritize them
  if (accessKeyId && secretAccessKey) {
    return memoize(async () => ({
      accessKeyId,
      secretAccessKey,
    }));
  }

  // A named profile (sandbox → a different account) is threaded into every profile-aware provider.
  const init = profile ? { ...baseInit, profile } : baseInit;

  // Otherwise, use standard resolution chain but skip the env variables provider (fromEnv)
  const remoteProvider = async () => {
    const ENV_CMDS_FULL_URI = 'AWS_CONTAINER_CREDENTIALS_FULL_URI';
    const ENV_CMDS_RELATIVE_URI = 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI';
    const ENV_IMDS_DISABLED = 'AWS_EC2_METADATA_DISABLED';

    if (process.env[ENV_CMDS_RELATIVE_URI] || process.env[ENV_CMDS_FULL_URI]) {
      return chain(fromHttp(init), fromContainerMetadata(init));
    }

    if (process.env[ENV_IMDS_DISABLED] && process.env[ENV_IMDS_DISABLED] !== 'false') {
      throw new Error('EC2 Instance Metadata Service access disabled');
    }

    return fromInstanceMetadata(init);
  };

  return memoize(
    chain(
      async () => fromSSO(init)(),
      async () => fromIni(init)(),
      async () => fromProcess(init)(),
      async () => fromTokenFile(init)(),
      async () => {
        const resolvedRemote = await remoteProvider();
        return resolvedRemote();
      },
    ),
    (credentials: any) =>
      credentials?.expiration !== undefined &&
      credentials.expiration.getTime() - Date.now() < 300_000,
    (credentials: any) => credentials?.expiration !== undefined,
  );
}

export class SecretsManagerService implements SecretStore {
  private client: SecretsManagerClient | null = null;
  private readonly instance: SecretsInstanceConfig;

  /** Per-instance simulation store (prod and sandbox never share simulated secrets). */
  private readonly sim = {
    seeded: false,
    secrets: new Map<string, SimSecret>(),
  };

  /** Short-lived cache of the account-wide secret list, to avoid a ListSecrets call per request. */
  private allSecretsCache: { names: string[]; expiresAt: number } | null = null;
  private static readonly ALL_SECRETS_TTL_MS = 30_000;

  constructor(instance: SecretsInstanceConfig) {
    this.instance = instance;
  }

  private get isSimulation(): boolean {
    return this.instance.isSimulation;
  }

  /** Whether this instance is running against the in-process mock store instead of real AWS. */
  getIsSimulation(): boolean {
    return this.instance.isSimulation;
  }

  private ensureSimSeeded(): void {
    if (this.sim.seeded) {return;}
    this.sim.seeded = true;
    if (this.instance.key === 'secrets-sandbox') {
      this.sim.secrets.set('sandbox/service-a', {
        name: 'sandbox/service-a',
        keys: ['SANDBOX_API_KEY'],
        values: { SANDBOX_API_KEY: 'sbx_key_abc' },
      });
      this.sim.secrets.set('sandbox/service-b', {
        name: 'sandbox/service-b',
        keys: ['SANDBOX_TOKEN'],
        values: { SANDBOX_TOKEN: 'sbx_tok_xyz' },
      });
      return;
    }
    this.sim.secrets.set('payment/gateway', {
      name: 'payment/gateway',
      keys: ['STRIPE_API_KEY', 'BRAINTREE_MERCHANT_ID'],
      values: {
        STRIPE_API_KEY: 'sk_test_123456',
        BRAINTREE_MERCHANT_ID: 'merchant_abc123',
      },
    });
    this.sim.secrets.set('payment/webhook', {
      name: 'payment/webhook',
      keys: ['WEBHOOK_SECRET_KEY'],
      values: {
        WEBHOOK_SECRET_KEY: 'whsec_xyz789',
      },
    });
  }

  private getClient(): SecretsManagerClient {
    if (this.client) {return this.client;}
    const region = this.instance.region;
    if (!region) {
      throw new ExternalServiceError('AWS region for Secrets Manager is not configured');
    }
    // Encryption in transit: the secret key/value pairs travel to AWS on the
    // GetSecretValue read path and the Put/CreateSecret write path. The SDK's
    // default endpoint is already HTTPS, but we harden it so the guarantee is
    // explicit and cannot be silently downgraded:
    //  1. Pin the request handler to an https.Agent with a TLS 1.2 floor, so a
    //     change to Node's global TLS defaults can never let a call negotiate a
    //     weaker/plaintext protocol.
    //  2. If an endpoint override is ever configured, reject anything that is
    //     not https:// — a plaintext endpoint would leak secrets on the wire.
    const endpoint = this.instance.endpoint;
    if (endpoint && !/^https:\/\//i.test(endpoint)) {
      throw new ExternalServiceError(
        `Refusing to use a non-HTTPS Secrets Manager endpoint (${endpoint}) — secrets must be encrypted in transit.`,
      );
    }

    this.client = new SecretsManagerClient({
      region,
      ...(endpoint ? { endpoint } : {}),
      maxAttempts: 6,
      retryMode: 'adaptive',
      credentials: getSecretsManagerProvider({
        accessKeyId: this.instance.accessKeyId,
        secretAccessKey: this.instance.secretAccessKey,
        profile: this.instance.profile,
      }),
      requestHandler: new NodeHttpHandler({
        httpsAgent: new HttpsAgent({ minVersion: 'TLSv1.2' }),
      }),
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

  // Scope-pattern parsing is provider-agnostic — the shared implementations live in
  // secret-store.interface.ts so the AWS and Azure stores can't drift apart. Kept as methods
  // because callers reach them as `svc.parseScopePatterns(...)`.

  /** Parse newline-separated secret names from a group's externalGroupId. */
  parseSecretNames(externalGroupId: string): string[] {
    return sharedParseSecretNames(externalGroupId);
  }

  /**
   * Parse a group's externalGroupId into scope patterns (exact names and/or wildcards).
   * `*` = every secret; `prefix*` = names starting with `prefix`; anything else = an exact name.
   */
  parseScopePatterns(externalGroupId: string): SecretScopePattern[] {
    return sharedParseScopePatterns(externalGroupId);
  }

  /** Whether a resolved secret name is covered by a scope pattern (case-insensitive). */
  matchesPattern(pattern: SecretScopePattern, secretName: string): boolean {
    return sharedMatchesPattern(pattern, secretName);
  }

  /**
   * Parse a secret's SecretString as a key-value JSON object. Returns null when the
   * payload is not key-value shaped (a plaintext blob, or JSON string/number/array —
   * all legitimate in AWS but not key-mergeable by Hermes). Without this guard,
   * JSON.parse threw a 500 on read, and a merge would have spread array indices /
   * string chars into the map, silently destroying the secret's format.
   */
  private parseKeyValueSecret(secretString: string): Record<string, string> | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(secretString);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, string>;
  }

  /**
   * List the existing key names for a secret (masking/omitting values).
   * `keyValueFormat: false` flags an existing secret whose payload is not key-value
   * JSON — it has no listable keys and cannot be merged into.
   */
  async listSecretKeys(
    name: string,
  ): Promise<{ exists: boolean; keys: string[]; keyValueFormat?: boolean }> {
    if (this.isSimulation) {
      this.ensureSimSeeded();
      const secret = this.sim.secrets.get(name);
      if (!secret) {
        return { exists: false, keys: [] };
      }
      return { exists: true, keys: secret.keys };
    }

    let secretString: string | undefined;
    try {
      const client = this.getClient();
      const command = new GetSecretValueCommand({ SecretId: name });
      const res = await client.send(command);
      secretString = res.SecretString;
    } catch (err: any) {
      if (err.name === 'ResourceNotFoundException') {
        return { exists: false, keys: [] };
      }
      logger.error({ err, secretName: name }, `Failed to list secret keys for ${name}`);
      throw this.mapAwsError(err, `Failed to list secret keys for ${name}`);
    }
    if (!secretString) {
      return { exists: true, keys: [] };
    }
    const data = this.parseKeyValueSecret(secretString);
    if (data === null) {
      return { exists: true, keys: [], keyValueFormat: false };
    }
    return { exists: true, keys: Object.keys(data) };
  }

  /**
   * Internal helper to fetch the raw key-value map of a secret.
   * Returns null if the secret does not exist.
   *
   * The `keys` narrowing hint from {@link SecretStore} is accepted but ignored here: a single
   * GetSecretValue already returns the whole blob, so filtering would cost a call, not save one.
   * Azure needs it (one GetSecret per key) — see key-vault.service.ts.
   */
  async getSecretMap(
    name: string,
    _keys?: string[],
  ): Promise<Record<string, string> | null> {
    if (this.isSimulation) {
      this.ensureSimSeeded();
      const secret = this.sim.secrets.get(name);
      if (!secret) {
        return null;
      }
      return { ...secret.values };
    }

    let secretString: string | undefined;
    try {
      const client = this.getClient();
      const command = new GetSecretValueCommand({ SecretId: name });
      const res = await client.send(command);
      secretString = res.SecretString;
    } catch (err: any) {
      if (err.name === 'ResourceNotFoundException') {
        return null;
      }
      logger.error({ err, secretName: name }, `Failed to fetch secret map for ${name}`);
      throw this.mapAwsError(err, `Failed to fetch secret map for ${name}`);
    }
    if (!secretString) {
      return {};
    }
    const data = this.parseKeyValueSecret(secretString);
    if (data === null) {
      throw new ValidationError(
        `Secret ${name} does not contain key-value JSON — cannot read it as a map.`,
      );
    }
    return data;
  }

  /**
   * Merges and writes the key-value pairs to the secret.
   */
  async putSecretKeyValues(
    name: string,
    kv: Record<string, string>,
    opts: { createIfMissing: boolean },
  ): Promise<void> {
    if (this.isSimulation) {
      this.ensureSimSeeded();
      let secret = this.sim.secrets.get(name);
      if (!secret) {
        if (!opts.createIfMissing) {
          throw new NotFoundError(`Secret ${name} not found in simulation store`);
        }
        secret = {
          name,
          keys: [],
          values: {},
        };
        this.sim.secrets.set(name, secret);
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
    let currentRaw: string | undefined;
    try {
      const getCommand = new GetSecretValueCommand({ SecretId: name });
      const getRes = await client.send(getCommand);
      currentRaw = getRes.SecretString;
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
    if (exists && currentRaw) {
      const parsed = this.parseKeyValueSecret(currentRaw);
      if (parsed === null) {
        throw new ValidationError(
          `Secret ${name} does not contain key-value JSON — refusing to merge keys into it (that would destroy its current format).`,
        );
      }
      currentMap = parsed;
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

  /** @deprecated AWS-flavoured alias for {@link listAllSecrets}; kept for existing call sites. */
  async listAllAwsSecrets(): Promise<string[]> {
    return this.listAllSecrets();
  }

  /**
   * List all secrets in the AWS account.
   */
  async listAllSecrets(): Promise<string[]> {
    if (this.isSimulation) {
      this.ensureSimSeeded();
      const extras = SIM_EXTRA_SECRETS[this.instance.key] ?? SIM_EXTRA_SECRETS.secrets;
      return [...new Set([...this.sim.secrets.keys(), ...extras])].sort();
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
   * Reset this instance's simulation store (for testing only)
   */
  __resetSim(): void {
    this.sim.seeded = true;
    this.sim.secrets.clear();
    this.allSecretsCache = null;
  }
}

/**
 * Memoized per-instance registry. Returns one {@link SecretsManagerService} per configured
 * Secret Ingestion platform key (e.g. "secrets", "secrets-sandbox"), each with its own AWS
 * client / credentials / simulation store — so prod and sandbox never share account state.
 * The prod instance ("secrets") is the exported singleton below, so callers (and tests that
 * spy on it) resolve to the same object.
 */
const serviceInstances = new Map<string, SecretStore>();

/**
 * Returns the {@link SecretStore} for a Secret Ingestion platform key, choosing the implementation
 * from the instance's `provider` ('aws' ⇒ Secrets Manager, 'azure' ⇒ Key Vault; absent ⇒ 'aws' so
 * every pre-Azure instance keeps its behaviour).
 */
export function getSecretsManagerService(platform: string): SecretStore {
  const key = platform.toLowerCase();
  const cached = serviceInstances.get(key);
  if (cached) {return cached;}
  const cfg = config.secretsInstances.find((i) => i.key === key);
  if (!cfg) {
    throw new ExternalServiceError(
      `No Secret Ingestion instance is configured for platform "${platform}".`,
    );
  }
  const svc: SecretStore =
    cfg.provider === 'azure'
      ? new KeyVaultService(cfg)
      : new SecretsManagerService(cfg);
  serviceInstances.set(key, svc);
  return svc;
}

export const secretsManagerService = getSecretsManagerService('secrets');
export default secretsManagerService;

/**
 * TEST-ONLY escape hatch for a real ordering hazard: several modules construct a
 * {@link PlatformAdapter}-family singleton at IMPORT time (`provisioningRegistry`,
 * `secretsProvisioner` here, `infraRepoSyncService`), and those eagerly call
 * `getSecretsManagerService` for every configured instance — including ones a test file expects
 * to control via its own `process.env.SECRETS_AZURE_*` overrides. Whichever import happens to
 * pull one of those singletons in FIRST permanently freezes this map's entry with whatever
 * `config.secretsInstances` produced at THAT moment, which can run before a test file's own
 * top-level env assignments take effect (a real, observed race — not exclusive to Vitest's
 * transform vs. Node's). Call this in a `beforeEach`/before creating requests, AFTER setting the
 * env vars the test needs, so the next `getSecretsManagerService` call re-reads `config` fresh.
 * Never call this from production code — it exists solely to undo test-order nondeterminism.
 */
export function __resetSecretsManagerServiceCacheForTest(): void {
  serviceInstances.clear();
}
