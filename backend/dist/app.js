"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("./config/config"); // Loads dotenv + normalizes env once
const config_1 = __importDefault(require("./config/config"));
const index_1 = __importDefault(require("./index"));
const logger_1 = __importDefault(require("./utils/logger"));
const secrets_1 = require("./config/secrets");
const keycloak_setup_1 = __importDefault(require("./config/keycloak-setup"));
const scheduler_service_1 = __importDefault(require("./services/scheduler.service"));
const sync_service_1 = __importDefault(require("./services/sync.service"));
const event_listeners_1 = require("./services/event-listeners");
const PORT = config_1.default.port;
async function bootstrap() {
    try {
        logger_1.default.info('🚀 Atlas Backend starting up...');
        // 0. Register event listeners
        (0, event_listeners_1.registerEventListeners)();
        // 1. Load AWS secrets (in production)
        await (0, secrets_1.loadSecrets)();
        // 2. Perform Keycloak check / client setup
        await keycloak_setup_1.default.ensureClientAndRolesExist();
        // 3. Start auto-revocation scheduler
        scheduler_service_1.default.start();
        // 4. Run an initial Redash Cache sync in the background
        sync_service_1.default.syncWithRedash()
            .then((res) => {
            logger_1.default.info(`🔄 Initial Redash sync complete. Cached ${res.usersSynced} users and ${res.groupsSynced} groups.`);
        })
            .catch((err) => {
            logger_1.default.warn('⚠️ Initial Redash sync failed. Cache might be stale. Proceeding...', err.message);
        });
        // 5. Start Express server
        const server = index_1.default.listen(PORT, () => {
            logger_1.default.info(`🚀 Atlas Backend listening on http://localhost:${PORT}`);
        });
        // Graceful shutdown
        const shutdown = () => {
            logger_1.default.info('Shutting down gracefully...');
            scheduler_service_1.default.stop();
            server.close(() => {
                logger_1.default.info('HTTP server closed.');
                process.exit(0);
            });
        };
        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);
    }
    catch (error) {
        logger_1.default.fatal('❌ Failed to bootstrap Atlas Application:', error.message);
        process.exit(1);
    }
}
bootstrap();
