import dotenv from 'dotenv';
dotenv.config(); // Single call, no more duplicates (fixes #32)

// Normalize NODE_ENV
if (process.env.NODE_ENV) {
  process.env.NODE_ENV = process.env.NODE_ENV.replace(/['"]/g, '').trim();
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '8001', 10),

  get isDev() {
    return this.nodeEnv === 'development' || this.nodeEnv === 'local';
  },
  get isProd() {
    return this.nodeEnv === 'production';
  },

  // ── Simulation Mode (Fixes #1 — SINGLE definition) ──
  get isSimulation() {
    // Simulation is ON when explicitly set to 'true' AND not in production
    return process.env.KEYCLOAK_SIMULATION === 'true' && !this.isProd;
  },

  // Read lazily via getters (NOT captured once at import). loadSecrets() injects
  // these from AWS Secrets Manager *after* this module loads, so a static capture
  // would be stale — e.g. the JWKS/issuer/audience the JWT verifier relies on, or
  // adminPassword (a stale `undefined` would make keycloakAdminService.isLive false
  // forever in prod). Same rationale as slack/email below.
  keycloak: {
    get jwksUri() { return process.env.KEYCLOAK_JWKS_URI || 'https://keycloak.bachatt.app/realms/master/protocol/openid-connect/certs'; },
    get issuer() { return process.env.KEYCLOAK_ISSUER || 'https://keycloak.bachatt.app/realms/master'; },
    get audience() { return process.env.KEYCLOAK_AUDIENCE; },
    get adminUrl() { return process.env.KEYCLOAK_ADMIN_URL || 'https://keycloak.bachatt.app'; },
    get adminClientId() { return process.env.KEYCLOAK_ADMIN_CLIENT_ID || 'admin-cli'; },
    get adminUsername() { return process.env.KEYCLOAK_ADMIN_USERNAME || 'admin'; },
    get adminPassword() { return process.env.KEYCLOAK_ADMIN_PASSWORD; },
    get realm() { return process.env.VITE_KEYCLOAK_REALM || 'master'; },
  },

  redash: {
    // Lazy getters (see keycloak note): baseUrl/apiKey may arrive from AWS Secrets
    // Manager after import. A static apiKey capture would stay the dev dummy →
    // isSimulation would wrongly return true in production.
    get baseUrl() { return process.env.REDASH_BASE_URL || 'https://redash.bachatt.app'; },
    get apiKey() { return process.env.REDASH_API_KEY || 'dummy-key-for-development'; },
    get isSimulation() {
      // ON only when explicitly requested, or when the key is still the dev
      // dummy. The previous `|| config.isDev` clause forced simulation on
      // locally even when REDASH_SIMULATION=false, making the toggle a no-op.
      return process.env.REDASH_SIMULATION === 'true'
        || this.apiKey === 'dummy-key-for-development';
    },
  },

  // NOTE: slack + email values are read lazily via getters (not captured once at
  // import). loadSecrets() injects these from AWS Secrets Manager *after* this
  // module is imported, so a static capture would be stale ('') in production.
  slack: {
    // Incoming webhook → posts to a single shared channel (team feed). Optional.
    get webhookUrl() { return process.env.SLACK_WEBHOOK_URL; },
    // Bot token (xoxb-…) → required for per-user DMs (users.lookupByEmail + chat.postMessage).
    get botToken() { return process.env.SLACK_BOT_TOKEN; },
    // DMs simulate (log instead of send) when no bot token is set, or when forced off.
    get dmSimulation() {
      return process.env.SLACK_SIMULATION === 'true' || !this.botToken;
    },
  },

  email: {
    // SES verified sender, e.g. "Hermes <no-reply@bachatt.app>". Required to send.
    get from() { return process.env.EMAIL_FROM || ''; },
    get replyTo() { return process.env.EMAIL_REPLY_TO; },
    // SES region — falls back to the general AWS region if unset.
    get region() { return process.env.SES_REGION || process.env.AWS_REGION; },
    // Optional dev-only address used as the "super admin" recipient in simulation.
    get simAdminEmail() { return process.env.SIM_ADMIN_EMAIL; },
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
    get region() { return process.env.AWS_REGION; },
    get accessKeyId() { return process.env.AWS_ACCESS_KEY_ID; },
    get secretAccessKey() { return process.env.AWS_SECRET_ACCESS_KEY; },
    get secretName() { return process.env.AWS_SECRET_NAME || 'Hermes-Prod'; },

    // ── IAM Identity Center (the `aws` provisioning adapter) ──
    // The Identity Store the adapter manages users/groups/memberships in, e.g.
    // "d-1234567890". Console: IAM Identity Center → Settings → Identity Store ID.
    get identityStoreId() { return process.env.AWS_IDENTITY_STORE_ID; },
    // Region the Identity Center instance lives in (it is a regional service).
    // Falls back to the general AWS_REGION when unset.
    get identityCenterRegion() { return process.env.AWS_IDENTITY_CENTER_REGION || process.env.AWS_REGION; },
    // Optional: the SSO instance ARN. Only needed if Hermes ever automates account
    // assignments (group → permission set → account) via sso-admin. The
    // membership-only flow does not use it — admins configure assignments once per
    // group in the console (analogous to Redash data-source permissions).
    get ssoInstanceArn() { return process.env.AWS_SSO_INSTANCE_ARN; },

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

  frontend: {
    url: process.env.FRONTEND_URL || 'http://localhost:5173',
    allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:5174')
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
      if (!v) return 0;
      return /^\d+$/.test(v) ? parseInt(v, 10) : v;
    },
  },
} as const;

export default config;
