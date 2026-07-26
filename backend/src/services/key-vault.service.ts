import { SecretClient } from '@azure/keyvault-secrets';
import { KeyVaultManagementClient } from '@azure/arm-keyvault';
import { ClientSecretCredential } from '@azure/identity';
import logger from '../utils/logger';
import { SIM_AZURE_VAULT_NAME } from '../config/config';
import {
  BaseError,
  ValidationError,
  ExternalServiceError,
  NotFoundError,
} from '../utils/errors';
import {
  SecretStore,
  SecretsInstanceConfig,
  SecretScopePattern,
  PartialWriteError,
  parseSecretNames as sharedParseSecretNames,
  parseScopePatterns as sharedParseScopePatterns,
  matchesPattern as sharedMatchesPattern,
} from './secret-store.interface';

/** One discovered vault: its canonical name and the data-plane URL to talk to it on. */
interface VaultRef {
  name: string;
  uri: string;
}

/**
 * Azure Key Vault implementation of {@link SecretStore}.
 *
 * ── The model ───────────────────────────────────────────────────────────────────────────────────
 * Key Vault secrets are FLAT: one secret holds one string, with no inner keys. AWS Secrets Manager
 * secrets are JSON blobs holding many keys, and Hermes' whole domain model (request → per-key
 * approve/reject → merge) is built on that two-level shape.
 *
 * To present the same shape without inventing structure Azure doesn't have, a VAULT is modelled as
 * a "secret" and that vault's secrets as its "keys":
 *
 *     secretName      = "bachatt-prod-kv"      (a vault)
 *     entries[].key   = "orbit-kfin-username"  (a Key Vault secret in it)
 *     entries[].value = the value
 *
 * So `listSecretKeys(vault)` enumerates one vault, and `putSecretKeyValues(vault, kv)` writes one
 * Key Vault secret per entry. Every caller above this class stays provider-agnostic.
 *
 * ── Two modes ───────────────────────────────────────────────────────────────────────────────────
 * DISCOVERY (`<prefix>_SUBSCRIPTION_ID`, no vault pin) — `listAllSecrets()` enumerates every vault
 * in the subscription via Azure Resource Manager, exactly as the AWS store's `listAllSecrets()`
 * enumerates every secret in the account. Group scope patterns then work identically across
 * providers: `*` = every vault, `bachatt-*` = vaults with that prefix, a bare name = that vault.
 * A vault created in Azure later shows up on the next read with no config change.
 *
 * PINNED (`<prefix>_VAULT_NAME`) — the instance is bound to exactly one vault and never calls ARM.
 * No subscription-level role needed. This is the narrower, more contained setup.
 *
 * ⚠ Consequence of the model, accepted deliberately: the unit of authorization is a WHOLE VAULT. A
 * user scoped to one may request a write to any service's secret in it and can enumerate every
 * secret name, and the approving admin sees `previousValue` for whatever key is being overwritten.
 * In DISCOVERY mode a `*` group therefore reaches every secret in every vault in the subscription
 * — the same blast radius a `*` group already has on the AWS instances. Security rests on the admin
 * approval step. Per-service isolation is not achievable without changing the unit of scope.
 *
 * ── Call cost ───────────────────────────────────────────────────────────────────────────────────
 * AWS returns every key in ONE GetSecretValue. Azure needs one paginated list per vault for the
 * names plus one GetSecret PER value, so {@link getSecretMap} honours the `keys` narrowing hint
 * from SecretStore and reads only what the caller asked for. Reading a whole vault is the fallback,
 * not the norm. Both the vault list and each vault's key list are briefly cached.
 */
export class KeyVaultService implements SecretStore {
  private readonly instance: SecretsInstanceConfig;

  /** Data-plane clients, one per vault, built lazily and reused. */
  private readonly clients = new Map<string, SecretClient>();
  private credential: ClientSecretCredential | null = null;
  private armClient: KeyVaultManagementClient | null = null;

  /**
   * Per-instance simulation store: vault name → (secret name → value), mirroring the real
   * multi-vault shape so the offline demo exercises the same code paths.
   */
  private readonly sim = {
    seeded: false,
    vaults: new Map<string, Map<string, string>>(),
  };

  /**
   * Short-lived cache of each vault's secret NAMES — the paginated list call is the expensive part
   * of every scope/keys read. Same 30s TTL as the AWS store's account-wide list.
   */
  private readonly vaultKeysCache = new Map<
    string,
    { names: string[]; expiresAt: number }
  >();
  private static readonly VAULT_KEYS_TTL_MS = 30_000;

  /**
   * Cache of the discovered vault list. Longer TTL than the key lists: vaults are created rarely,
   * and this is an ARM call on the path of every scope resolution.
   */
  private vaultsCache: { vaults: VaultRef[]; expiresAt: number } | null = null;
  private static readonly VAULTS_TTL_MS = 300_000;

  /** Bound on concurrent GetSecret calls when reading many values at once. */
  private static readonly READ_CONCURRENCY = 8;

  /**
   * Key Vault object-name rule: 1–127 chars of alphanumerics and dashes only. Validated up front so
   * a bad name fails with a clear Hermes error instead of an opaque Azure 400 mid-write.
   */
  private static readonly VALID_SECRET_NAME = /^[0-9a-zA-Z-]{1,127}$/;

  constructor(instance: SecretsInstanceConfig) {
    this.instance = instance;
  }

  private get isSimulation(): boolean {
    return this.instance.isSimulation;
  }

  getIsSimulation(): boolean {
    return this.instance.isSimulation;
  }

  /** The vault this instance is pinned to, if any. Empty ⇒ discovery mode. */
  private get pinnedVault(): string {
    return (this.instance.vaultName || '').trim();
  }

  private get subscriptionId(): string {
    return (this.instance.subscriptionId || '').trim();
  }

  private ensureSimSeeded(): void {
    if (this.sim.seeded) {
      return;
    }
    this.sim.seeded = true;
    // Multiple vaults so the multi-vault flow (vault picker → keys) is demoable offline. Names and key
    // shapes mirror the real bachatt-prod-kv (see azure/orbit and azure/saathi-be on
    // infra-deployment origin/main) — including the `<service>-<rest>` convention deriveEnvVar()
    // depends on — but deliberately NOT the real vault name, so a simulated instance can never be
    // mistaken for production.
    const seed: Record<string, Record<string, string>> = {
      [SIM_AZURE_VAULT_NAME]: {
        'orbit-kfin-username': 'orbit_kfin_user',
        'orbit-kfin-password': 'orbit_kfin_pass_2026',
        'orbit-azure-openai-api-key': 'sk-proj-azure-openai-sim-key-8899',
        'orbit-report-email': 'reports@bachatt.app',
        'saathi-app-jwt-secret': 'sim_jwt_secret_saathi_v2',
        'saathi-database-url': 'postgres://saathi_user:saathi_pass@azure-pg.bachatt.internal:5432/saathi',
        'saathi-azure-storage-key': 'DefaultEndpointsProtocol=https;AccountName=saathistorage;AccountKey=simStorageKey123==',
        'tolgee-db-password': 'sim_tolgee_db_secret_pass',
        'findesk-be-db-password': 'sim_findesk_azure_kv_pass',
        'findesk-be-client-secret': 'sim_findesk_client_secret_xyz789',
        'notification-sendgrid-api-key': 'SG.sim_azure_sendgrid_key_123456',
        'payment-gateway-razorpay-secret': 'rzp_live_sim_azure_kv_secret_888',
      },
      [`${SIM_AZURE_VAULT_NAME}-analytics`]: {
        'metabase-db-password': 'sim_metabase_pass_analytics',
        'metabase-encryption-key': 'sim_metabase_enc_key_998877',
        'clickhouse-user-password': 'sim_clickhouse_db_pass_2026',
        'grafana-admin-password': 'sim_grafana_azure_admin_pass',
      },
      [`${SIM_AZURE_VAULT_NAME}-prod`]: {
        'prod-auth-rsa-key': '-----BEGIN RSA PRIVATE KEY-----\nSIM_AZURE_RSA_KEY_DATA\n-----END RSA PRIVATE KEY-----',
        'prod-tls-cert-key': '-----BEGIN CERTIFICATE-----\nSIM_AZURE_CERT_DATA\n-----END CERTIFICATE-----',
      },
    };
    for (const [vault, secrets] of Object.entries(seed)) {
      this.sim.vaults.set(vault, new Map(Object.entries(secrets)));
    }
    // A pinned instance must be able to see its own vault even if the pin isn't one of the seeds.
    if (this.pinnedVault && !this.sim.vaults.has(this.pinnedVault)) {
      this.sim.vaults.set(this.pinnedVault, new Map());
    }
  }

  private getCredential(): ClientSecretCredential {
    if (this.credential) {
      return this.credential;
    }
    const { tenantId, clientId, clientSecret } = this.instance;
    if (!tenantId || !clientId || !clientSecret) {
      throw new ExternalServiceError(
        'Azure Key Vault credentials are not configured — SECRETS_AZURE_TENANT_ID, ' +
          'SECRETS_AZURE_CLIENT_ID and SECRETS_AZURE_CLIENT_SECRET are all required for live mode.',
      );
    }
    // Hermes runs on AWS ECS and therefore has no Azure managed identity of its own. (The
    // `useVMManagedIdentity: "true"` in the AKS manifests is how the CLUSTER reads these vaults — a
    // different principal entirely.) So a service principal is the credential here.
    this.credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    return this.credential;
  }

  /** Data-plane client for one vault, cached. */
  private clientFor(vault: VaultRef): SecretClient {
    const cached = this.clients.get(vault.name.toLowerCase());
    if (cached) {
      return cached;
    }
    // Encryption in transit: secret values travel to Azure on every get/set. ARM hands back an
    // https vaultUri and the constructed default is https too — but an endpoint override is
    // operator-supplied, so verify rather than assume.
    if (!/^https:\/\//i.test(vault.uri)) {
      throw new ExternalServiceError(
        `Refusing to use a non-HTTPS Key Vault endpoint (${vault.uri}) — secrets must be encrypted in transit.`,
      );
    }
    const client = new SecretClient(vault.uri, this.getCredential());
    this.clients.set(vault.name.toLowerCase(), client);
    return client;
  }

  /**
   * Translate an Azure SDK error into the project's error hierarchy. Returns rather than throws so
   * a caller mid-way through a multi-call write can wrap it (see {@link PartialWriteError}).
   */
  private toAzureError(err: any, op: string): BaseError {
    const status: number | undefined = err?.statusCode ?? err?.status;
    const code: string | undefined = err?.code;
    const msg = err?.message || String(err);
    const ctx = { op, azureErrorCode: code, azureStatus: status };
    if (status === 404 || code === 'SecretNotFound') {
      return new NotFoundError(`Secret not found during ${op}: ${msg}`, ctx);
    }
    if (status === 400 || code === 'BadParameter') {
      return new ValidationError(`Key Vault rejected ${op}: ${msg}`, ctx);
    }
    if (status === 401 || status === 403) {
      return new ExternalServiceError(
        `Key Vault denied ${op} — check the service principal's access policy / RBAC role: ${msg}`,
        ctx,
      );
    }
    return new ExternalServiceError(`Key Vault error during ${op}: ${msg}`, ctx);
  }

  private mapAzureError(err: any, op: string): never {
    throw this.toAzureError(err, op);
  }

  // ── Vault discovery ───────────────────────────────────────────────────────────────────────────

  /**
   * Every vault this instance can see, cached.
   *
   * PINNED mode short-circuits to the one configured vault and never calls ARM — so a narrow setup
   * needs no subscription-level role. DISCOVERY mode lists the subscription's vaults through the
   * Key Vault MANAGEMENT plane (`@azure/arm-keyvault`), which is a different API from the
   * secrets data plane: the data-plane SDK can only talk to a vault URL you already know, so
   * enumeration is impossible without it.
   */
  private async discoverVaults(): Promise<VaultRef[]> {
    if (this.isSimulation) {
      this.ensureSimSeeded();
      const names = this.pinnedVault
        ? [this.pinnedVault]
        : [...this.sim.vaults.keys()].sort();
      return names.map((name) => ({
        name,
        uri: `https://${name}.vault.azure.net`,
      }));
    }

    if (this.pinnedVault) {
      return [
        {
          name: this.pinnedVault,
          uri:
            this.instance.endpoint ||
            `https://${this.pinnedVault}.vault.azure.net`,
        },
      ];
    }

    const now = Date.now();
    if (this.vaultsCache && this.vaultsCache.expiresAt > now) {
      return this.vaultsCache.vaults;
    }

    if (!this.subscriptionId) {
      throw new ExternalServiceError(
        `Secret Ingestion instance "${this.instance.key}" has neither a vault name nor a subscription id — ` +
          'set <prefix>_VAULT_NAME to pin it to one vault, or <prefix>_SUBSCRIPTION_ID to discover every vault.',
      );
    }

    try {
      if (!this.armClient) {
        this.armClient = new KeyVaultManagementClient(
          this.getCredential(),
          this.subscriptionId,
        );
      }
      const vaults: VaultRef[] = [];
      for await (const v of this.armClient.vaults.listBySubscription()) {
        // vaultUri is what the data plane needs; without it the vault is unusable, so skip rather
        // than guess a URL that may not resolve (sovereign clouds don't use vault.azure.net).
        const uri = v.properties?.vaultUri;
        if (v.name && uri) {
          vaults.push({ name: v.name, uri });
        }
      }
      vaults.sort((a, b) => a.name.localeCompare(b.name));
      this.vaultsCache = {
        vaults,
        expiresAt: now + KeyVaultService.VAULTS_TTL_MS,
      };
      logger.info(
        { instance: this.instance.key, count: vaults.length },
        'Discovered Azure Key Vaults in subscription',
      );
      return vaults;
    } catch (err: any) {
      logger.error(
        { err, instance: this.instance.key, subscriptionId: this.subscriptionId },
        'Failed to list Azure Key Vaults for the subscription',
      );
      throw this.toAzureError(err, 'list Key Vaults in the subscription');
    }
  }

  /**
   * Resolve a caller-supplied vault name to a real one, case-insensitively (Azure vault names are
   * case-insensitive). Returns null when no such vault is visible — which is how an out-of-scope or
   * mistyped name is refused rather than silently read/written somewhere else.
   */
  private async resolveVault(name: string): Promise<VaultRef | null> {
    const wanted = (name || '').trim().toLowerCase();
    if (!wanted) {
      return null;
    }
    const vaults = await this.discoverVaults();
    return vaults.find((v) => v.name.toLowerCase() === wanted) ?? null;
  }

  /** Every non-deleted secret name in one vault, cached briefly. */
  private async listVaultKeys(vault: VaultRef): Promise<string[]> {
    if (this.isSimulation) {
      this.ensureSimSeeded();
      return [...(this.sim.vaults.get(vault.name)?.keys() ?? [])].sort();
    }

    const cacheKey = vault.name.toLowerCase();
    const now = Date.now();
    const cached = this.vaultKeysCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.names;
    }

    try {
      const client = this.clientFor(vault);
      const names: string[] = [];
      for await (const props of client.listPropertiesOfSecrets()) {
        if (props.name) {
          names.push(props.name);
        }
      }
      const sorted = names.sort();
      this.vaultKeysCache.set(cacheKey, {
        names: sorted,
        expiresAt: now + KeyVaultService.VAULT_KEYS_TTL_MS,
      });
      return sorted;
    } catch (err: any) {
      logger.error({ err, vault: vault.name }, 'Failed to list Key Vault secrets');
      throw this.mapAzureError(err, `list secrets in ${vault.name}`);
    }
  }

  /** Read one secret's value; null when it doesn't exist (a NEW key, not an error). */
  private async readOne(vault: VaultRef, name: string): Promise<string | null> {
    try {
      const secret = await this.clientFor(vault).getSecret(name);
      return secret.value ?? null;
    } catch (err: any) {
      const status: number | undefined = err?.statusCode ?? err?.status;
      if (status === 404 || err?.code === 'SecretNotFound') {
        return null;
      }
      throw this.mapAzureError(err, `read secret ${name} in ${vault.name}`);
    }
  }

  // ── SecretStore ───────────────────────────────────────────────────────────────────────────────

  /**
   * Key Vault's own object-name rule, checked at REQUEST time (see SecretStore.validateKeyName) as
   * well as before every write. Checking it only at write time would let a request be submitted —
   * and its infra PR opened — for a name Azure will refuse the moment a reviewer approves.
   */
  validateKeyName(key: string): void {
    if (!KeyVaultService.VALID_SECRET_NAME.test(key)) {
      throw new ValidationError(
        `"${key}" is not a valid Key Vault secret name — only letters, numbers and dashes are allowed (1–127 characters). ` +
          'Underscores are not permitted; use dashes instead (e.g. "orbit-kfin-username").',
      );
    }
  }

  async listSecretKeys(
    name: string,
  ): Promise<{ exists: boolean; keys: string[]; keyValueFormat?: boolean }> {
    const vault = await this.resolveVault(name);
    if (!vault) {
      return { exists: false, keys: [] };
    }
    return { exists: true, keys: await this.listVaultKeys(vault) };
  }

  async getSecretMap(
    name: string,
    keys?: string[],
  ): Promise<Record<string, string> | null> {
    const vault = await this.resolveVault(name);
    if (!vault) {
      return null;
    }

    if (this.isSimulation) {
      this.ensureSimSeeded();
      const store = this.sim.vaults.get(vault.name) ?? new Map<string, string>();
      const out: Record<string, string> = {};
      const wanted = keys?.length ? keys : [...store.keys()];
      for (const k of wanted) {
        const v = store.get(k);
        if (v !== undefined) {
          out[k] = v;
        }
      }
      return out;
    }

    // Only read what was asked for — one GetSecret per key, so a whole-vault read is the expensive
    // fallback rather than the default (see the class doc).
    const wanted = keys?.length
      ? [...new Set(keys.map((k) => k.trim()).filter(Boolean))]
      : await this.listVaultKeys(vault);

    const out: Record<string, string> = {};
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(KeyVaultService.READ_CONCURRENCY, wanted.length) },
      async () => {
        while (cursor < wanted.length) {
          const key = wanted[cursor++];
          const value = await this.readOne(vault, key);
          if (value !== null) {
            out[key] = value;
          }
        }
      },
    );
    await Promise.all(workers);
    return out;
  }

  async putSecretKeyValues(
    name: string,
    kv: Record<string, string>,
    opts: { createIfMissing: boolean },
  ): Promise<void> {
    const vault = await this.resolveVault(name);
    if (!vault) {
      // Hermes can create a Key Vault SECRET, never a vault — so an unknown vault name is always a
      // hard stop, whatever createIfMissing says.
      if (opts.createIfMissing) {
        throw new ValidationError(
          `"${name}" is not a Key Vault this instance can see — Hermes can create secrets in an existing vault, ` +
            'but never the vault itself. Create it in Azure first, or check the name.',
        );
      }
      throw new NotFoundError(`Key Vault ${name} not found`);
    }

    const entries = Object.entries(kv);
    for (const [key] of entries) {
      this.validateKeyName(key);
    }

    if (this.isSimulation) {
      this.ensureSimSeeded();
      let store = this.sim.vaults.get(vault.name);
      if (!store) {
        store = new Map<string, string>();
        this.sim.vaults.set(vault.name, store);
      }
      for (const [k, v] of entries) {
        store.set(k, v);
      }
      return;
    }

    // One call per key — Key Vault has no multi-secret write, so this CANNOT be atomic the way
    // AWS's single PutSecretValue is. Track what actually landed so a mid-loop failure reports a
    // partial write instead of "nothing applied" (which would both misstate the audit trail and
    // leave the written values live but unrecorded).
    const client = this.clientFor(vault);
    const written: string[] = [];
    for (const [k, v] of entries) {
      try {
        await client.setSecret(k, v);
        written.push(k);
      } catch (err: any) {
        // Drop the cached name list first: keys written before the failure may be brand new, and a
        // stale cache would hide them from reads for the rest of the TTL.
        this.vaultKeysCache.delete(vault.name.toLowerCase());
        const mapped = this.toAzureError(err, `write secret ${k} in ${vault.name}`);
        if (written.length === 0) {
          throw mapped;
        }
        throw new PartialWriteError(mapped.message, written, {
          vault: vault.name,
          failedKey: k,
        });
      }
    }
    // New secrets may have just come into existence — drop the cached name list so they surface on
    // the next read instead of waiting out the TTL.
    this.vaultKeysCache.delete(vault.name.toLowerCase());
  }

  /**
   * The "secrets" this instance exposes are its vaults — a vault is the unit a group scopes to and
   * the unit a request targets. In discovery mode this is every vault in the subscription, which is
   * what makes `*` and `prefix*` group scopes behave exactly as they do on the AWS instances.
   */
  async listAllSecrets(): Promise<string[]> {
    return (await this.discoverVaults()).map((v) => v.name);
  }

  /** @deprecated AWS-flavoured alias for {@link listAllSecrets}; kept for existing call sites. */
  async listAllAwsSecrets(): Promise<string[]> {
    return this.listAllSecrets();
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (this.isSimulation) {
      return { healthy: true, message: 'simulation' };
    }
    try {
      const vaults = await this.discoverVaults();
      if (vaults.length === 0) {
        return {
          healthy: false,
          message:
            'no Key Vaults visible to this service principal — check its Reader role on the subscription',
        };
      }
      // One page of one vault's secrets proves the DATA plane works too, not just ARM: the two use
      // different permissions and it is normal to have one without the other.
      const iterator = this.clientFor(vaults[0])
        .listPropertiesOfSecrets()
        .byPage({ maxPageSize: 1 });
      await iterator.next();
      return { healthy: true };
    } catch (err: any) {
      return { healthy: false, message: err?.message || String(err) };
    }
  }

  // Scope-pattern parsing is provider-agnostic — shared with the AWS store so the two can't drift.

  parseSecretNames(externalGroupId: string): string[] {
    return sharedParseSecretNames(externalGroupId);
  }

  parseScopePatterns(externalGroupId: string): SecretScopePattern[] {
    return sharedParseScopePatterns(externalGroupId);
  }

  matchesPattern(pattern: SecretScopePattern, secretName: string): boolean {
    return sharedMatchesPattern(pattern, secretName);
  }

  /** Reset this instance's simulation store (for testing only). */
  __resetSim(): void {
    this.sim.seeded = true;
    this.sim.vaults.clear();
    this.vaultKeysCache.clear();
    this.vaultsCache = null;
  }
}
