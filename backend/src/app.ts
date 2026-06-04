import './config/config'; // Loads dotenv + normalizes env once

import config from './config/config';
import logger from './utils/logger';
import { loadSecrets } from './config/secrets';

// NOTE: the Express app, middleware, and services are imported *dynamically* inside
// bootstrap() — AFTER loadSecrets() — because several modules read config at import
// time (the express-jwt verifier in auth.middleware captures JWKS/issuer/audience at
// construction; redash + keycloak config too). Importing them statically up here
// would run that capture before AWS Secrets Manager injects the real values, leaving
// them stale for the lifetime of the process.

const PORT = config.port;

/**
 * Log how the notification channels resolved once secrets are in env. Loudly
 * warns on the silent-simulation footgun (e.g. EMAIL_SIMULATION=false but no
 * sender configured → emails would be quietly dropped instead of sent).
 */
function reportNotificationReadiness(): void {
  if (config.email.isSimulation) {
    if (process.env.EMAIL_SIMULATION === 'false') {
      logger.warn('📧 Email: EMAIL_SIMULATION=false but EMAIL_FROM is unset — emails will be SIMULATED (not sent). Set a verified SES sender to go live.');
    } else if (config.isProd) {
      logger.warn('📧 Email: running in SIMULATION mode in production — no emails will be sent. Set EMAIL_FROM + EMAIL_SIMULATION=false to enable.');
    } else {
      logger.info('📧 Email: simulation mode (emails are logged, not sent).');
    }
  } else {
    logger.info(`📧 Email: LIVE via SES (sender: ${config.email.from}, region: ${config.email.region ?? 'default'}).`);
  }

  if (config.slack.dmSimulation) {
    if (process.env.SLACK_SIMULATION === 'false') {
      logger.warn('💬 Slack DMs: SLACK_SIMULATION=false but SLACK_BOT_TOKEN is unset — DMs will be SIMULATED. Add a bot token to enable.');
    } else if (config.isProd) {
      logger.warn('💬 Slack DMs: running in SIMULATION mode in production — no DMs will be sent.');
    } else {
      logger.info('💬 Slack DMs: simulation mode (DMs are logged, not sent).');
    }
  } else {
    logger.info('💬 Slack DMs: LIVE via bot token.');
  }
}

async function bootstrap() {
  try {
    logger.info('🚀 Hermes Backend starting up...');

    // 1. Load AWS secrets FIRST (prod). Must precede every dynamic import below so
    //    config reads (Keycloak JWKS/issuer/audience, Redash key, adminPassword) see
    //    the real values rather than import-time defaults.
    await loadSecrets();

    // 1.5 Report notification channel readiness (now that secrets are in env)
    reportNotificationReadiness();

    // 2. Import the app + services now that env is fully populated (dynamic import so
    //    their module-load-time config captures happen after loadSecrets).
    const { default: app } = await import('./index');
    const { default: keycloakSetupService } = await import('./config/keycloak-setup');
    const { default: schedulerService } = await import('./services/scheduler.service');
    const { default: syncService } = await import('./services/sync.service');
    const { registerEventListeners } = await import('./services/event-listeners');

    // 3. Register event listeners (before anything can emit)
    registerEventListeners();

    // 4. Perform Keycloak check / client setup
    await keycloakSetupService.ensureClientAndRolesExist();

    // 5. Start auto-revocation scheduler
    schedulerService.start();

    // 6. Run an initial platform cache sync in the background
    syncService.syncAllPlatforms()
      .then((res) => {
        logger.info(`🔄 Initial platform sync complete. Cached ${res.usersSynced} users and ${res.groupsSynced} groups.`);
      })
      .catch((err) => {
        logger.warn('⚠️ Initial platform sync failed. Cache might be stale. Proceeding...', err.message);
      });

    // 7. Start Express server
    const server = app.listen(PORT, () => {
      logger.info(`🚀 Hermes Backend listening on http://localhost:${PORT}`);
    });

    // Graceful shutdown
    const shutdown = () => {
      logger.info('Shutting down gracefully...');
      schedulerService.stop();
      server.close(() => {
        logger.info('HTTP server closed.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

  } catch (error: any) {
    logger.fatal('❌ Failed to bootstrap Hermes Application:', error.message);
    process.exit(1);
  }
}

bootstrap();
