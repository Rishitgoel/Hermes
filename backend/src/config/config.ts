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
      return process.env.REDASH_SIMULATION === 'true'
        || this.apiKey === 'dummy-key-for-development'
        || config.isDev;
    },
  },

  slack: {
    webhookUrl: process.env.SLACK_WEBHOOK_URL,
  },

  aws: {
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    secretName: process.env.AWS_SECRET_NAME || 'Atlas-Prod',
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
