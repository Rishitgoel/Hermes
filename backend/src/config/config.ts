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

  keycloak: {
    jwksUri: process.env.KEYCLOAK_JWKS_URI || 'https://keycloak.bachatt.app/realms/master/protocol/openid-connect/certs',
    issuer: process.env.KEYCLOAK_ISSUER || 'https://keycloak.bachatt.app/realms/master',
    audience: process.env.KEYCLOAK_AUDIENCE,
    adminUrl: process.env.KEYCLOAK_ADMIN_URL || 'https://keycloak.bachatt.app',
    adminClientId: process.env.KEYCLOAK_ADMIN_CLIENT_ID || 'admin-cli',
    adminUsername: process.env.KEYCLOAK_ADMIN_USERNAME || 'admin',
    adminPassword: process.env.KEYCLOAK_ADMIN_PASSWORD,
    realm: process.env.VITE_KEYCLOAK_REALM || 'master',
  },

  redash: {
    baseUrl: process.env.REDASH_BASE_URL || 'https://redash.bachatt.app',
    apiKey: process.env.REDASH_API_KEY || 'dummy-key-for-development',
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
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    secretName: process.env.AWS_SECRET_NAME || 'Hermes-Prod',
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
  },
} as const;

export default config;
