import './config/config'; // Loads dotenv + normalizes env once

import config from './config/config';
import app from './index';
import logger from './utils/logger';
import { loadSecrets } from './config/secrets';
import keycloakSetupService from './config/keycloak-setup';
import schedulerService from './services/scheduler.service';
import syncService from './services/sync.service';

import { registerEventListeners } from './services/event-listeners';

const PORT = config.port;

async function bootstrap() {
  try {
    logger.info('🚀 Hermes Backend starting up...');

    // 0. Register event listeners
    registerEventListeners();

    // 1. Load AWS secrets (in production)
    await loadSecrets();

    // 2. Perform Keycloak check / client setup
    await keycloakSetupService.ensureClientAndRolesExist();

    // 3. Start auto-revocation scheduler
    schedulerService.start();

    // 4. Run an initial Redash Cache sync in the background
    syncService.syncWithRedash()
      .then((res) => {
        logger.info(`🔄 Initial Redash sync complete. Cached ${res.usersSynced} users and ${res.groupsSynced} groups.`);
      })
      .catch((err) => {
        logger.warn('⚠️ Initial Redash sync failed. Cache might be stale. Proceeding...', err.message);
      });

        // 5. Start Express server
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
