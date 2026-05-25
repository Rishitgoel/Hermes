"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
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
const app = (0, express_1.default)();
exports.app = app;
// Security and utility middleware
app.use(security_middleware_1.helmetMiddleware);
app.use(security_middleware_1.securityHeaders);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:5174')
    .split(',')
    .map(o => o.trim());
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
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
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
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
