"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const security_middleware_1 = require("./middleware/security.middleware");
const error_middleware_1 = require("./middleware/error.middleware");
const auth_route_1 = __importDefault(require("./routes/auth.route"));
const group_route_1 = __importDefault(require("./routes/group.route"));
const access_request_route_1 = __importDefault(require("./routes/access-request.route"));
const user_access_route_1 = __importDefault(require("./routes/user-access.route"));
const notification_route_1 = __importDefault(require("./routes/notification.route"));
const audit_route_1 = __importDefault(require("./routes/audit.route"));
const admin_route_1 = __importDefault(require("./routes/admin.route"));
const config_1 = __importDefault(require("./config/config"));
const prisma_1 = __importDefault(require("./config/prisma"));
const provisioning_registry_1 = __importDefault(require("./services/provisioning.registry"));
const app = (0, express_1.default)();
// Security and utility middleware
app.use(security_middleware_1.helmetMiddleware);
app.use(security_middleware_1.securityHeaders);
const allowedOrigins = config_1.default.frontend.allowedOrigins;
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        if (!origin) {
            // Allow server-to-server / health-check / Postman only in non-prod
            if (config_1.default.isDev) {
                callback(null, true);
            }
            else {
                callback(new Error('Origin header required in production'));
            }
        }
        else if (allowedOrigins.includes(origin)) {
            callback(null, true);
        }
        else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
}));
app.use(express_1.default.json());
app.use(error_middleware_1.requestIdMiddleware);
app.use(error_middleware_1.performanceMiddleware);
app.use(security_middleware_1.generalRateLimiter);
// Health check endpoint (unauthenticated)
app.get('/health', async (req, res) => {
    const checks = { timestamp: new Date().toISOString() };
    // Database check
    try {
        await prisma_1.default.$queryRaw `SELECT 1`;
        checks.database = 'healthy';
    }
    catch (err) {
        checks.database = 'unhealthy';
        checks.databaseError = err.message;
    }
    // Platform checks (via registry)
    try {
        checks.platforms = await provisioning_registry_1.default.healthCheckAll();
    }
    catch (err) {
        checks.platforms = 'error';
        checks.platformsError = err.message;
    }
    const allHealthy = checks.database === 'healthy';
    res.status(allHealthy ? 200 : 503).json({
        status: allHealthy ? 'ok' : 'degraded',
        ...checks,
    });
});
// App Routes
app.use('/auth', auth_route_1.default);
app.use('/api/groups', group_route_1.default);
app.use('/api/access-requests', access_request_route_1.default);
app.use('/api/user-access', user_access_route_1.default);
app.use('/api/notifications', notification_route_1.default);
app.use('/api/audit', audit_route_1.default);
app.use('/api/admin', admin_route_1.default);
// Fallbacks
app.use(error_middleware_1.notFoundHandler);
app.use(error_middleware_1.errorHandler);
exports.default = app;
