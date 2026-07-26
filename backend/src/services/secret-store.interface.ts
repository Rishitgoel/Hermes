import { ValidationError, ExternalServiceError } from '../utils/errors';

/**
 * A write that succeeded for SOME keys before failing.
 *
 * AWS Secrets Manager replaces a secret's whole JSON blob in one PutSecretValue, so a write there
 * is all-or-nothing and this never occurs. Azure Key Vault stores one secret per key and must
 * issue one call each, so a mid-loop failure genuinely leaves the vault partly updated. Carrying
 * the keys that DID land lets the review path mark exactly those as applied — otherwise a partial
 * write is audited as "nothing applied" while the values are already live in the vault.
 */
export class PartialWriteError extends ExternalServiceError {
  readonly writtenKeys: string[];

  constructor(
    message: string,
    writtenKeys: string[],
    context?: Record<string, unknown>,
  ) {
    super(message, { ...context, writtenKeys });
    this.writtenKeys = writtenKeys;
  }
}

/**
 * Provider-agnostic contract for a Secret Ingestion backing store.
 *
 * Two implementations exist today:
 *  - {@link SecretsManagerService} (`provider: 'aws'`) — AWS Secrets Manager, where ONE secret is a
 *    JSON blob holding many keys.
 *  - {@link KeyVaultService} (`provider: 'azure'`) — Azure Key Vault, where each vault secret is a
 *    single flat value. The vault itself is modelled as the "secret" and its secrets as the "keys",
 *    so the two providers present the same two-level shape to every caller.
 *
 * Lives in its own module (rather than in secrets-manager.service.ts) so the AWS service, the Key
 * Vault service, and the `getSecretsManagerService` factory can all depend on it without a cycle.
 */
export interface SecretStore {
  /**
   * List the existing key names for a secret (never the values).
   * `keyValueFormat: false` flags an existing secret whose payload is not key-value shaped — it has
   * no listable keys and cannot be merged into. Azure never sets it (a vault is always enumerable).
   */
  listSecretKeys(
    name: string,
  ): Promise<{ exists: boolean; keys: string[]; keyValueFormat?: boolean }>;

  /**
   * Fetch a secret's key-value map, or null when it does not exist.
   *
   * `keys` narrows the read to just those keys. AWS ignores it — one GetSecretValue already returns
   * the whole blob — but Azure needs one GetSecret call PER key, so passing it turns a whole-vault
   * read into a handful of calls. Callers that only care about specific keys (the review-queue
   * `previousValue` hydration, the pre-write snapshot) should always pass it.
   */
  getSecretMap(
    name: string,
    keys?: string[],
  ): Promise<Record<string, string> | null>;

  /** Merge key-value pairs into the secret, creating it when `createIfMissing`. */
  putSecretKeyValues(
    name: string,
    kv: Record<string, string>,
    opts: { createIfMissing: boolean },
  ): Promise<void>;

  /**
   * Throw if the provider itself would reject this key name, so a request is refused at SUBMIT
   * time rather than at approval. Without it the ordering is wrong in a way that costs real work:
   * the infra PR is opened when the request is created, so an unacceptable name gets a manifest
   * edit written for it and only fails once a reviewer approves — stranding the request and
   * leaving a PR registering a key that can never exist.
   *
   * Optional: AWS Secrets Manager accepts any JSON key, so only the Key Vault store implements it.
   */
  validateKeyName?(key: string): void;

  /** Every secret name this instance can see (AWS: the account's secrets; Azure: the vault(s)). */
  listAllSecrets(): Promise<string[]>;

  /** @deprecated AWS-flavoured alias for {@link listAllSecrets}; kept for existing call sites. */
  listAllAwsSecrets(): Promise<string[]>;

  healthCheck(): Promise<{ healthy: boolean; message?: string }>;

  /** Whether this instance runs against its in-process mock store instead of the real provider. */
  getIsSimulation(): boolean;

  parseSecretNames(externalGroupId: string): string[];
  parseScopePatterns(externalGroupId: string): SecretScopePattern[];
  matchesPattern(pattern: SecretScopePattern, secretName: string): boolean;

  /** Reset the simulation store (tests only). */
  __resetSim(): void;
}

/** Connection details for one Secret Ingestion instance (prod, sandbox, azure, ...). */
export interface SecretsInstanceConfig {
  /** Instance / provisioning-registry platform key, e.g. "secrets" or "secrets-azure". */
  key: string;
  /**
   * Which backing store this instance talks to. Selects the {@link SecretStore} implementation in
   * `getSecretsManagerService`. Absent ⇒ 'aws' (every instance that predates Azure support).
   */
  provider?: 'aws' | 'azure';
  /** These mirror config.secretsInstances[*] getters and are read lazily (secrets may load post-import). */
  readonly region: string | undefined;
  readonly endpoint: string | undefined;
  readonly isSimulation: boolean;
  readonly accessKeyId: string | undefined;
  readonly secretAccessKey: string | undefined;
  readonly profile: string | undefined;
  /**
   * Azure only — pins this instance to ONE Key Vault, e.g. "bachatt-prod-kv". Leave unset (with
   * `subscriptionId` set) to discover every vault in the subscription instead, which is what makes
   * `*` / `prefix*` group scopes work across vaults the way they do across AWS secrets.
   */
  readonly vaultName?: string | undefined;
  /**
   * Azure only — the subscription whose Key Vaults this instance can see. Required for discovery
   * mode; unused when `vaultName` pins the instance to a single vault. Listing vaults is the Key
   * Vault MANAGEMENT plane (a Reader role), separate from the secrets data plane.
   */
  readonly subscriptionId?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | undefined;
}

/**
 * A single line in a secrets group's externalGroupId, classified for scope resolution.
 * - `all`    → the literal `*`; matches every secret in the account.
 * - `prefix` → a trailing-`*` pattern (e.g. `investments*`); matches names starting with the prefix.
 * - `exact`  → a concrete secret name (the original, back-compatible form).
 *
 * Wildcard patterns are resolved LIVE against the provider's list at read time, so newly-created
 * secrets that match are automatically in scope without editing the group.
 */
export type SecretScopePattern =
  | { kind: 'all'; raw: string }
  | { kind: 'prefix'; prefix: string; raw: string }
  | { kind: 'exact'; name: string; raw: string };

// ---------------------------------------------------------------------------
// Shared scope-pattern helpers
//
// Pure functions over the externalGroupId string — identical for every provider, so both stores
// delegate to these rather than carrying their own copy. Exposed as SecretStore methods because
// callers reach them as `svc.parseScopePatterns(...)` (see secret-ingestion.service.ts).
// ---------------------------------------------------------------------------

/** Parse newline-separated secret names from a group's externalGroupId. */
export function parseSecretNames(externalGroupId: string): string[] {
  const names = new Set<string>();
  for (const line of (externalGroupId || '').split(/\r?\n/)) {
    const name = line.trim();
    if (name) {
      names.add(name);
    }
  }
  if (names.size === 0) {
    throw new ValidationError(
      `Invalid Secret Ingestion group id "${externalGroupId}" — expected at least one secret name, one per line.`,
    );
  }
  return [...names];
}

/**
 * Parse a group's externalGroupId into scope patterns (exact names and/or wildcards).
 * `*` = every secret; `prefix*` = names starting with `prefix`; anything else = an exact name.
 */
export function parseScopePatterns(
  externalGroupId: string,
): SecretScopePattern[] {
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
      `Invalid Secret Ingestion group id "${externalGroupId}" — expected at least one secret name or wildcard pattern, one per line.`,
    );
  }
  return patterns;
}

/** Whether a resolved secret name is covered by a scope pattern (case-insensitive). */
export function matchesPattern(
  pattern: SecretScopePattern,
  secretName: string,
): boolean {
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
 * Derive the env-var name a Key Vault secret should be exposed as in a Helm values manifest.
 *
 * Azure's `secretsStore.mappings[]` needs BOTH the vault secret name (`objectName`) and the env var
 * it lands in (`key`) — unlike AWS's `items:`, where the key name IS the env var. The convention is
 * verified consistent across every entry in azure/orbit and azure/saathi-be on infra-deployment
 * `origin/main`: drop the leading `<service>-` segment, uppercase, dashes → underscores.
 *
 *   orbit-kfin-username        → KFIN_USERNAME
 *   saathi-azure-storage-key   → AZURE_STORAGE_KEY
 *
 * azure/tolgee is a legacy outlier (`tolgee-db-password` → `SPRING_DATASOURCE_PASSWORD`), which is
 * why this is only ever a PREFILL — the requester can override it, and an explicit override is
 * always preferred over this guess.
 */
export function deriveEnvVar(objectName: string): string {
  const trimmed = (objectName || '').trim();
  if (!trimmed) {
    return '';
  }
  // Drop the leading service segment only when there IS a following segment — a single-segment
  // name (e.g. "database-url" with no service prefix) must keep all of itself.
  const parts = trimmed.split('-');
  const body = parts.length > 1 ? parts.slice(1) : parts;
  return body
    .join('_')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .toUpperCase();
}
