import dotenv from 'dotenv';
dotenv.config(); // Single call, no more duplicates (fixes #32)

// Normalize NODE_ENV
if (process.env.NODE_ENV) {
  process.env.NODE_ENV = process.env.NODE_ENV.replace(/['"]/g, '').trim();
}

/**
 * SSRF guard for a GitHub API base URL: only allow api.github.com or a GitHub Enterprise host,
 * https only — so a misconfigured env can't redirect authenticated requests to an internal
 * service (e.g. the AWS metadata endpoint). Shared by every infra-repo instance (prod + sandbox).
 * `envName` names the offending variable in the thrown error.
 */
function validateGithubApiUrl(raw: string, envName: string): string {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const allowed =
      host === 'api.github.com' ||
      host.endsWith('.ghe.com') ||
      host.endsWith('.github.com');
    if (!allowed || url.protocol !== 'https:') {
      throw new Error(
        `${envName} must be https:// and point to api.github.com or a GitHub Enterprise host, got: ${raw}`,
      );
    }
  } catch (err: any) {
    if (err.message.startsWith(envName)) {throw err;}
    throw new Error(`${envName} is not a valid URL: ${raw}`);
  }
  return raw;
}

/**
 * Vault name the simulated Azure Key Vault instance uses when SECRETS_AZURE_VAULT_NAME is unset.
 * Deliberately NOT the real `bachatt-prod-kv`, so a simulated instance can never be mistaken for
 * the production vault in a group's externalGroupId, an audit row, or a log line.
 */
export const SIM_AZURE_VAULT_NAME = 'bachatt-sim-kv';

/**
 * Build the Azure Key Vault Secret Ingestion instance (`secrets-azure`) from a `<prefix>_*` env
 * block.
 *
 * Enabled once `<prefix>_VAULT_NAME` is set (live) or `<prefix>_SIMULATION=true` (offline). An
 * unconfigured prefix yields `enabled: false` and is skipped at registration
 * (provisioning.registry.ts), so no dead adapter appears in the instance chooser.
 */
function azureSecretsInstance(opts: {
  key: string;
  label: string;
  displayName: string;
  envPrefix: string;
}) {
  const { key, label, displayName, envPrefix: p } = opts;
  const env = (suffix: string): string | undefined =>
    process.env[`${p}_${suffix}`];

  const vault = env('VAULT_NAME') || '';
  const subscriptionId = env('SUBSCRIPTION_ID') || '';
  const simExplicit = env('SIMULATION') === 'true';
  // Either mode counts as configured: a vault pin (one vault, no ARM) or a subscription id
  // (discover every vault, like the AWS store lists every secret in the account).
  const enabled = !!vault || !!subscriptionId || simExplicit;
  const isSimulation = simExplicit || (!vault && !subscriptionId);
  // Only an EXPLICIT vault name pins the instance. Left unset, it runs in discovery mode — live,
  // that enumerates the subscription's vaults; simulated, KeyVaultService serves its seeded mock
  // vaults. Either way `<prefix>_SIMULATION=true` alone is a complete local setup, and the local
  // shape matches the live one (a vault picker, not a single hardcoded vault).
  const vaultName = vault;

  // Explicitly asking for live mode with neither a vault pin nor a subscription would otherwise
  // fall through to the simulated store — writes would appear to succeed while landing nowhere.
  // Fail at config load.
  if (env('SIMULATION') === 'false' && !vault && !subscriptionId) {
    throw new Error(
      `${p}_SIMULATION=false (Azure Key Vault live mode requested) but neither ${p}_SUBSCRIPTION_ID nor ` +
        `${p}_VAULT_NAME is set. Without one the instance would silently fall back to the in-process simulation ` +
        `store and every write would be discarded. Set ${p}_SUBSCRIPTION_ID to discover every vault in the ` +
        `subscription, or ${p}_VAULT_NAME to pin this instance to a single vault.`,
    );
  }

  return {
    key,
    family: 'secrets',
    label,
    displayName,
    provider: 'azure' as const,
    enabled,
    // AWS-shaped fields the shared SecretsInstanceConfig requires; unused by the Key Vault store.
    region: undefined as string | undefined,
    accessKeyId: undefined as string | undefined,
    secretAccessKey: undefined as string | undefined,
    profile: undefined as string | undefined,
    // Optional vault URL override (e.g. a private endpoint). Unset ⇒ https://<vault>.vault.azure.net.
    get endpoint(): string | undefined {
      return env('ENDPOINT');
    },
    get vaultName(): string | undefined {
      return vaultName || undefined;
    },
    // Discovery mode: which subscription's vaults this instance can see. Ignored when vaultName
    // pins the instance to one vault.
    get subscriptionId(): string | undefined {
      return subscriptionId || undefined;
    },
    // Service-principal credentials. Hermes runs on AWS ECS and has no Azure managed identity of
    // its own, so these are required for live mode. Secret-backed — must stay lazy getters.
    get tenantId(): string | undefined {
      return env('TENANT_ID');
    },
    get clientId(): string | undefined {
      return env('CLIENT_ID');
    },
    get clientSecret(): string | undefined {
      return env('CLIENT_SECRET');
    },
    get isSimulation(): boolean {
      return isSimulation;
    },
    // Mirrors the SAME infra-deployment repo as prod (not a separate one like the sandbox), scoped
    // to `azure/` — the AKS manifests live alongside the EKS ones. Prod's own scope is NOT
    // excluded from `azure/` in return (see the prod infraRepo config below) — a one-directional,
    // deliberately accepted trade-off, not a mutual isolation guarantee.
    get infraRepo() {
      return {
        get token(): string | undefined {
          return env('INFRA_REPO_TOKEN') || config.infraRepo.token;
        },
        get owner(): string {
          return env('INFRA_REPO_OWNER') || config.infraRepo.owner;
        },
        get repo(): string {
          return env('INFRA_REPO_NAME') || config.infraRepo.repo;
        },
        get baseBranch(): string {
          return env('INFRA_REPO_BASE_BRANCH') || config.infraRepo.baseBranch;
        },
        get apiBaseUrl(): string {
          return config.infraRepo.apiBaseUrl;
        },
        get isSimulation(): boolean {
          return env('INFRA_REPO_SIMULATION') === 'true' || !this.token;
        },
        // Independent of the prod instance's toggle — approving an Azure key is a separate
        // decision from approving an AWS one.
        get autoMergeEnabled(): boolean {
          return env('INFRA_REPO_AUTO_MERGE') === 'true';
        },
        // Only ever scan/edit the AKS manifests.
        pathInclude: 'azure/',
        manifestFlavor: 'azure' as const,
      };
    },
    get infraEnabled(): boolean {
      return true;
    },
  };
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '8001', 10),

  database: {
    get encryptionKey() {
      return process.env.DB_ENCRYPTION_KEY || 'hermes-default-development-encryption-key-32bytes';
    },
  },

  get isDev() {
    return this.nodeEnv === 'development' || this.nodeEnv === 'local';
  },
  get isProd() {
    return this.nodeEnv === 'production';
  },

  // ── Simulation Mode (Fixes #1 — SINGLE definition) ──
  get isSimulation() {
    // Simulation is ON when explicitly set to 'true' (or ALLOW_SIMULATION_IN_PROD=true)
    return (
      process.env.KEYCLOAK_SIMULATION === 'true' ||
      process.env.ALLOW_SIMULATION_IN_PROD === 'true' ||
      (process.env.KEYCLOAK_SIMULATION !== 'false' && !this.isProd)
    );
  },

  // Read lazily via getters (NOT captured once at import). loadSecrets() injects
  // these from AWS Secrets Manager *after* this module loads, so a static capture
  // would be stale — e.g. the JWKS/issuer/audience the JWT verifier relies on, or
  // adminPassword (a stale `undefined` would make keycloakAdminService.isLive false
  // forever in prod). Same rationale as slack/email below.
  keycloak: {
    get jwksUri() {
      return (
        process.env.KEYCLOAK_JWKS_URI ||
        'https://keycloak.bachatt.app/realms/master/protocol/openid-connect/certs'
      );
    },
    get issuer() {
      return (
        process.env.KEYCLOAK_ISSUER ||
        'https://keycloak.bachatt.app/realms/master'
      );
    },
    get audience() {
      return process.env.KEYCLOAK_AUDIENCE;
    },
    get adminUrl() {
      return process.env.KEYCLOAK_ADMIN_URL || 'https://keycloak.bachatt.app';
    },
    get adminClientId() {
      return process.env.KEYCLOAK_ADMIN_CLIENT_ID || 'admin-cli';
    },
    get adminUsername() {
      return process.env.KEYCLOAK_ADMIN_USERNAME || 'admin';
    },
    get adminPassword() {
      return process.env.KEYCLOAK_ADMIN_PASSWORD;
    },
    get realm() {
      return process.env.VITE_KEYCLOAK_REALM || 'master';
    },
  },

  // ── Platform routing (provisioning-registry-agnostic) ──
  platform: {
    // The platform a brand-new user is onboarded to on first login (the row
    // /auth/me auto-drafts) and the implicit target when an API caller omits
    // `platform`. Must match a registered adapter key. This is the SINGLE place
    // the "default platform" lives — change it here to re-home the default rather
    // than editing the literal across controllers/services.
    get default() {
      return (process.env.DEFAULT_PLATFORM || 'redash').toLowerCase();
    },
  },

  redash: {
    // Lazy getters (see keycloak note): baseUrl/apiKey may arrive from AWS Secrets
    // Manager after import. A static apiKey capture would stay the dev dummy →
    // isSimulation would wrongly return true in production.
    get baseUrl() {
      return process.env.REDASH_BASE_URL || 'https://redash.bachatt.app';
    },
    get apiKey() {
      return process.env.REDASH_API_KEY || 'dummy-key-for-development';
    },
    get isSimulation() {
      // ON only when explicitly requested, or when the key is still the dev
      // dummy. The previous `|| config.isDev` clause forced simulation on
      // locally even when REDASH_SIMULATION=false, making the toggle a no-op.
      return (
        process.env.REDASH_SIMULATION === 'true' ||
        this.apiKey === 'dummy-key-for-development'
      );
    },
  },    

  // Every registered Redash instance (prod + any additional environments like QA),
  // keyed by its provisioning-registry platform key. `redash` (prod) is sourced
  // from config.redash above so existing installs need no env changes. Additional
  // instances (e.g. `redash-qa`) are opt-in: an instance with an empty baseUrl is
  // skipped at registration (provisioning.registry.ts) so an unconfigured entry
  // never registers a dead adapter. Add more entries here for further instances —
  // nothing else needs to change to support them.
  get redashInstances() {
    return [
      {
        key: 'redash',
        family: 'redash',
        label: 'Prod',
        displayName: 'Redash',
        baseUrl: config.redash.baseUrl,
        apiKey: config.redash.apiKey,
        isSimulation: config.redash.isSimulation,
      },
      {
        key: 'redash-qa',
        family: 'redash',
        label: 'QA',
        displayName: 'Redash (QA)',
        get baseUrl() {
          return process.env.REDASH_QA_BASE_URL || '';
        },
        get apiKey() {
          return process.env.REDASH_QA_API_KEY || 'dummy-key-for-development';
        },
        get isSimulation() {
          return (
            process.env.REDASH_QA_SIMULATION === 'true' ||
            this.apiKey === 'dummy-key-for-development'
          );
        },
      },
    ];
  },

  // NOTE: slack + email values are read lazily via getters (not captured once at
  // import). loadSecrets() injects these from AWS Secrets Manager *after* this
  // module is imported, so a static capture would be stale ('') in production.
  slack: {
    // Bot token (xoxb-…) → required for per-user DMs (users.lookupByEmail + chat.postMessage).
    get botToken() {
      return process.env.SLACK_BOT_TOKEN;
    },
    // DMs simulate (log instead of send) when no bot token is set, or when forced off.
    get dmSimulation() {
      return process.env.SLACK_SIMULATION === 'true' || !this.botToken;
    },
  },

  email: {
    // SES verified sender, e.g. "Hermes <no-reply@bachatt.app>". Required to send.
    get from() {
      return process.env.EMAIL_FROM || '';
    },
    get replyTo() {
      return process.env.EMAIL_REPLY_TO;
    },
    // SES region — falls back to the general AWS region if unset.
    get region() {
      return process.env.SES_REGION || process.env.AWS_REGION;
    },
    // Optional dev-only address used as the "super admin" recipient in simulation.
    get simAdminEmail() {
      return process.env.SIM_ADMIN_EMAIL;
    },
    // Simulate (log instead of send) when explicitly requested, or when no sender
    // is configured. Set EMAIL_SIMULATION=false + EMAIL_FROM=… in prod to go live.
    get isSimulation() {
      return process.env.EMAIL_SIMULATION === 'true' || !this.from;
    },
  },

  aws: {
    // Lazy getters (see keycloak/redash notes): several of these can arrive from
    // AWS Secrets Manager *after* this module is imported, so a static capture
    // would be stale. `region` is special — secrets.ts reads it at module load to
    // build the Secrets Manager client *before* loadSecrets() runs; the getter
    // reads the same process.env at that moment, so the conversion is harmless for
    // it (it must already be in .env to bootstrap secrets).
    get isEnabled() {
      return process.env.AWS_ENABLED !== 'false';
    },

    get region() {
      return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';
    },
    get accessKeyId() {
      return process.env.AWS_ACCESS_KEY_ID;
    },
    get secretAccessKey() {
      return process.env.AWS_SECRET_ACCESS_KEY;
    },
    // Prefer Hermes' OWN secret name. When Hermes runs embedded inside admin-panel,
    // AWS_SECRET_NAME is admin-panel's secret — reading it would fetch the wrong blob
    // (missing Hermes' Keycloak/Redash/Slack config) and clobber shared process.env.
    // So a dedicated HERMES_AWS_SECRET_NAME wins; AWS_SECRET_NAME stays only as a
    // fallback for the standalone Hermes deployable. loadSecrets() warns on that fallback.
    get secretName() {
      return (
        process.env.HERMES_AWS_SECRET_NAME ||
        process.env.AWS_SECRET_NAME ||
        'Hermes-Prod'
      );
    },

    // ── IAM Identity Center (the `aws` provisioning adapter) ──
    // The Identity Store the adapter manages users/groups/memberships in, e.g.
    // "d-1234567890". Console: IAM Identity Center → Settings → Identity Store ID.
    get identityStoreId() {
      return process.env.AWS_IDENTITY_STORE_ID;
    },
    // Region the Identity Center instance lives in (it is a regional service).
    // Falls back to the general AWS_REGION when unset.
    get identityCenterRegion() {
      return process.env.AWS_IDENTITY_CENTER_REGION || process.env.AWS_REGION;
    },
    // Optional: the SSO instance ARN. Only needed if Hermes ever automates account
    // assignments (group → permission set → account) via sso-admin. The
    // membership-only flow does not use it — admins configure assignments once per
    // group in the console (analogous to Redash data-source permissions).
    get ssoInstanceArn() {
      return process.env.AWS_SSO_INSTANCE_ARN;
    },
    // The AWS access portal (SSO start) URL, e.g. https://d-xxxx.awsapps.com/start.
    // Used in the onboarding email so a newly-created user can set their password on
    // first sign-in (AWS does not send an activation email for API-created users).
    get accessPortalUrl() {
      return process.env.AWS_ACCESS_PORTAL_URL;
    },

    // Simulate the AWS adapter (mock, no real AWS calls) when explicitly requested,
    // or whenever no Identity Store id is configured (so a half-configured env can
    // never accidentally fire real Identity Store calls). This flag is INDEPENDENT
    // of KEYCLOAK/REDASH simulation and of the secrets.ts boot gate: every
    // aws-identity-center.service method checks it BEFORE constructing the SDK
    // client, so sim short-circuits even after secrets have loaded. Going live
    // therefore needs AWS_SIMULATION=false + AWS_IDENTITY_STORE_ID + a region +
    // credentials (task role in prod; never root).
    get isSimulation() {
      return process.env.AWS_SIMULATION === 'true' || !this.identityStoreId;
    },
  },

  zookeeper: {
    // The `zookeeper` provisioning adapter. Managed znodes are world-open
    // (world:anyone:cdrwa); access is enforced at the Hermes application layer (Postgres),
    // not via per-znode ACLs. A Hermes group is a znode path, a level is "<path>#<perms>".
    // The ensemble is network-isolated, reachable only through Hermes. Lazy getters (see
    // keycloak/redash notes): connectString/adminAuth may arrive from AWS Secrets Manager
    // after import.
    //
    // The ensemble connect string, e.g. "zk-0:2181,zk-1:2181". Unset locally ⇒ sim.
    get connectString() {
      return process.env.ZOOKEEPER_CONNECT_STRING || '';
    },
    // Root znode path Hermes treats as the top of its managed tree: backing group nodes
    // are created under it, and the world-open migration scans from it. Defaults to "/"
    // (the whole ensemble, minus the reserved /zookeeper subtree) — set ZOOKEEPER_ROOT_PATH
    // to a narrower prefix to scope Hermes to a subtree when the ensemble is shared.
    get rootPath() {
      return process.env.ZOOKEEPER_ROOT_PATH || '/';
    },
    // The super-digest "user:password" Hermes authenticates as to setACL on the
    // target znodes (needs ADMIN there). Secret-backed — must stay a lazy getter.
    get adminAuth() {
      return process.env.ZOOKEEPER_ADMIN_AUTH;
    },
    // Simulate (in-process mock, no real ZooKeeper) when explicitly requested, or
    // whenever no connect string is configured (so a half-configured env can never
    // accidentally hit a real ensemble). INDEPENDENT of the other simulation flags.
    // Going live needs ZOOKEEPER_SIMULATION=false + a connect string + a wired client.
    get isSimulation() {
      return process.env.ZOOKEEPER_SIMULATION === 'true' || !this.connectString;
    },
  },

  secrets: {
    get region() {
      return process.env.SECRETS_INGESTION_REGION || process.env.AWS_REGION;
    },
    // Optional Secrets Manager endpoint override (e.g. a VPC interface endpoint /
    // PrivateLink DNS name, or a FIPS endpoint). Unset ⇒ the SDK's default
    // regional HTTPS endpoint. Must be https:// — the client rejects any plaintext
    // override so ingested secrets are always encrypted in transit.
    get endpoint() {
      return process.env.SECRETS_INGESTION_ENDPOINT;
    },
    get accessKeyId() {
      return (
        process.env.SECRETS_INGESTION_AWS_ACCESS_KEY_ID ||
        process.env.SECRETS_INGESTION_ACCESS_KEY_ID
      );
    },
    get secretAccessKey() {
      return (
        process.env.SECRETS_INGESTION_AWS_SECRET_ACCESS_KEY ||
        process.env.SECRETS_INGESTION_SECRET_ACCESS_KEY
      );
    },
    get isSimulation() {
      return process.env.SECRETS_INGESTION_SIMULATION === 'true' || !this.region;
    },
  },

  // Every registered Secret Ingestion instance, keyed by its provisioning-registry platform
  // key. `secrets` (prod + QA — one AWS account, secrets namespaced by env prefix) is sourced
  // from config.secrets above so existing installs need no env changes. `secrets-sandbox` is a
  // SECOND AWS account (opt-in): enabled once SECRETS_SANDBOX_REGION is set (go-live),
  // SECRETS_SANDBOX_SIMULATION=true (local two-instance testing), or SECRETS_SANDBOX_PROFILE is
  // named — otherwise it's skipped at registration (provisioning.registry.ts) so an
  // unconfigured entry never registers a dead adapter. Both share `family: 'secrets'` so the UI
  // collapses them into one Secret Ingestion surface with a prod/sandbox chooser (same pattern
  // as redashInstances). The sandbox authenticates via the SDK default credential chain only
  // (no dedicated key env vars); SECRETS_SANDBOX_PROFILE selects a named AWS profile so it can
  // resolve a different account than prod.
  get secretsInstances() {
    const sandboxRegion = process.env.SECRETS_SANDBOX_REGION || '';
    const sandboxProfile = process.env.SECRETS_SANDBOX_PROFILE || '';
    const sandboxSimExplicit = process.env.SECRETS_SANDBOX_SIMULATION === 'true';
    const sandboxEnabled = !!sandboxRegion || sandboxSimExplicit || !!sandboxProfile;
    const sandboxIsSimulation = sandboxSimExplicit || !sandboxRegion;
    // Guard against the sandbox silently sharing prod's AWS credentials: with no
    // SECRETS_SANDBOX_PROFILE, the sandbox's credential chain resolves identically to prod's
    // (same ECS task role / IMDS, no dedicated keys) — so a live (non-simulated) sandbox with no
    // profile would write "sandbox" secrets straight into the prod AWS account. Fail fast at
    // config load rather than silently cross-writing accounts.
    if (sandboxEnabled && !sandboxIsSimulation && !sandboxProfile) {
      throw new Error(
        'SECRETS_SANDBOX_REGION is set (sandbox enabled, live mode) but SECRETS_SANDBOX_PROFILE is not. ' +
          'Without a distinct profile the sandbox resolves the same AWS credentials as prod (ECS task role / IMDS), ' +
          'so sandbox writes would silently land in the prod AWS account. Set SECRETS_SANDBOX_PROFILE to a named ' +
          'AWS profile for a separate account, or set SECRETS_SANDBOX_SIMULATION=true for local testing.',
      );
    }
    const azureMain = azureSecretsInstance({
      key: 'secrets-azure',
      label: 'Azure',
      displayName: 'Secret Ingestion (Azure)',
      envPrefix: 'SECRETS_AZURE',
    });
    return [
      {
        key: 'secrets',
        family: 'secrets',
        label: 'Prod + QA',
        displayName: 'Secret Ingestion',
        provider: 'aws' as const,
        enabled: true,
        get region() {
          return config.secrets.region;
        },
        get endpoint() {
          return config.secrets.endpoint;
        },
        get isSimulation() {
          return config.secrets.isSimulation;
        },
        // Prod: dedicated Hermes AWS keys if present, else the SDK default chain (unchanged
        // from how the single-instance `secrets` adapter has always resolved credentials).
        get accessKeyId(): string | undefined {
          return config.aws.accessKeyId;
        },
        get secretAccessKey(): string | undefined {
          return config.aws.secretAccessKey;
        },
        profile: undefined as string | undefined,
        // infra-deployment PR mirror for this instance. Prod uses the existing INFRA_REPO_*
        // config and is always on (simulated in dev, live in prod) — unchanged behavior.
        get infraRepo() {
          return config.infraRepo;
        },
        infraEnabled: true,
      },
      {
        key: 'secrets-sandbox',
        family: 'secrets',
        label: 'Sandbox',
        displayName: 'Secret Ingestion (Sandbox)',
        provider: 'aws' as const,
        enabled: !!sandboxRegion || sandboxSimExplicit || !!sandboxProfile,
        get region() {
          return process.env.SECRETS_SANDBOX_REGION || '';
        },
        get endpoint() {
          return process.env.SECRETS_SANDBOX_ENDPOINT;
        },
        get isSimulation() {
          return process.env.SECRETS_SANDBOX_SIMULATION === 'true' || !this.region;
        },
        // Sandbox: SDK default credential chain only (no dedicated keys). SECRETS_SANDBOX_PROFILE
        // optionally selects a named AWS profile so a different account is reachable.
        accessKeyId: undefined as string | undefined,
        secretAccessKey: undefined as string | undefined,
        get profile(): string | undefined {
          return process.env.SECRETS_SANDBOX_PROFILE || undefined;
        },
        // infra-deployment PR mirror for the sandbox — its OWN GitHub repo (SECRETS_SANDBOX_INFRA_REPO_*).
        // Wired but OFF until the sandbox repo is added: infraEnabled is false unless a repo name is
        // set (go-live) or SECRETS_SANDBOX_INFRA_REPO_ENABLED=true (local simulation testing). While
        // off, sandbox requests write to AWS only and open no PR.
        get infraRepo() {
          return {
            get token(): string | undefined {
              return process.env.SECRETS_SANDBOX_INFRA_REPO_TOKEN;
            },
            get owner(): string {
              return process.env.SECRETS_SANDBOX_INFRA_REPO_OWNER || 'bachatt-app';
            },
            get repo(): string {
              // No default repo — the sandbox repo doesn't exist yet.
              return process.env.SECRETS_SANDBOX_INFRA_REPO_NAME || '';
            },
            get baseBranch(): string {
              return process.env.SECRETS_SANDBOX_INFRA_REPO_BASE_BRANCH || 'main';
            },
            get apiBaseUrl(): string {
              return validateGithubApiUrl(
                process.env.SECRETS_SANDBOX_INFRA_REPO_API_URL || 'https://api.github.com',
                'SECRETS_SANDBOX_INFRA_REPO_API_URL',
              );
            },
            get isSimulation(): boolean {
              return process.env.SECRETS_SANDBOX_INFRA_REPO_SIMULATION === 'true' || !this.token;
            },
            get autoMergeEnabled(): boolean {
              return process.env.SECRETS_SANDBOX_INFRA_REPO_AUTO_MERGE === 'true';
            },
          };
        },
        get infraEnabled(): boolean {
          return (
            !!process.env.SECRETS_SANDBOX_INFRA_REPO_NAME ||
            process.env.SECRETS_SANDBOX_INFRA_REPO_ENABLED === 'true'
          );
        },
      },
      azureMain,
    ];
  },

  // Mirrors approved Secret Ingestion keys into the infra-deployment repo as a GitHub PR
  // (see infra-repo-sync.service.ts). Adding a key to an AWS secret is invisible to the
  // pods until its NAME is registered in that repo's manifests, so Hermes opens a PR whose
  // lifecycle tracks the ingestion request.
  infraRepo: {
    get token() {
      return process.env.INFRA_REPO_TOKEN;
    },
    get owner() {
      return process.env.INFRA_REPO_OWNER || 'bachatt-app';
    },
    get repo() {
      return process.env.INFRA_REPO_NAME || 'infra-deployment';
    },
    get baseBranch() {
      return process.env.INFRA_REPO_BASE_BRANCH || 'main';
    },
    get apiBaseUrl() {
      return validateGithubApiUrl(
        process.env.INFRA_REPO_API_URL || 'https://api.github.com',
        'INFRA_REPO_API_URL',
      );
    },
    // Simulate (no GitHub calls, deterministic fake PR) when explicitly requested, or
    // whenever no token is configured — so a half-configured env can never accidentally
    // push to the real repo. Going live needs INFRA_REPO_SIMULATION=false + a PAT with
    // contents + pull-request write on the repo.
    get isSimulation() {
      return process.env.INFRA_REPO_SIMULATION === 'true' || !this.token;
    },
    // The `azure/` folder is INCLUDED in this instance's scan (not excluded) — a deliberate,
    // reviewed choice: the real infra-deployment repo has at least one genuinely AWS-shaped
    // manifest (azure/findesk-be/prod/values-prod.yaml, an EKS/ALB deployment) misfiled under
    // `azure/`, which this instance otherwise could never discover or edit. ⚠ Known accepted
    // risk: `manifestRef` on a requester's infraTargets is client-supplied and unvalidated
    // against their own scope (secret-ingestion.validation.ts), and the Azure-shaped manifests
    // under `azure/` (orbit, saathi-be, tolgee — all carry `keyvaultName:`) are now in this
    // instance's reachable path set. A requester with ONLY AWS `secrets` access can point their
    // own request's infraTargets at one of those files with a manifestRef matching a real Key
    // Vault name; whether that write actually lands still depends on
    // isAzureValuesFile's routing (see infra-repo-sync.service.ts) correctly steering it to the
    // AWS editor rather than falling back to path-based Azure detection.
    get autoMergeEnabled() {
      return process.env.INFRA_REPO_AUTO_MERGE === 'true';
    },
  },

  frontend: {
    url: process.env.FRONTEND_URL || 'http://localhost:5173',
    allowedOrigins: (
      process.env.ALLOWED_ORIGINS ||
      'http://localhost:5173,http://localhost:5174'
    )
      .split(',')
      .map(o => o.trim()),
  },

  rateLimiting: {
    // Fixes #6 — Rate limiting ON by default, opt-out in dev
    get enabled() {
      if (process.env.ENABLE_LIMIT_RATE !== undefined) {
        return process.env.ENABLE_LIMIT_RATE === 'true';
      }
      if (process.env.ENABLE_RATE_LIMIT !== undefined) {
        return process.env.ENABLE_RATE_LIMIT === 'true';
      }
      return !config.isDev; // ON in prod by default
    },
  },

  security: {
    enableHelmet: process.env.SECURITY_HELMET !== 'false',
    // Proxy hops to trust (ALB / API Gateway) so req.ip is the real client and a
    // spoofed X-Forwarded-For can't be used to bypass rate limiting. A numeric
    // string → hop count; anything else is passed through (e.g. 'loopback').
    // 0 = trust no proxy (correct for local dev).
    get trustProxy(): number | string {
      const v = process.env.TRUST_PROXY;
      if (!v) {
        return 0;
      }
      return /^\d+$/.test(v) ? parseInt(v, 10) : v;
    },
  },
} as const;

export default config;
