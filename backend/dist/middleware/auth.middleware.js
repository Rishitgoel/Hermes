"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireRole = exports.authenticateToken = void 0;
const express_jwt_1 = require("express-jwt");
const jwks_rsa_1 = __importDefault(require("jwks-rsa"));
const logger_1 = __importDefault(require("../utils/logger"));
const checkJwtLive = (0, express_jwt_1.expressjwt)({
    secret: jwks_rsa_1.default.expressJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: process.env.KEYCLOAK_JWKS_URI || 'https://keycloak.bachatt.app/realms/master/protocol/openid-connect/certs',
    }),
    algorithms: ['RS256'],
    issuer: process.env.KEYCLOAK_ISSUER || 'https://keycloak.bachatt.app/realms/master',
    audience: process.env.KEYCLOAK_AUDIENCE || 'atlas-prod',
});
// Middleware for Live mapping
const mapLiveKeycloakUser = (req, res, next) => {
    if (req.auth) {
        const roles = req.auth.realm_access?.roles || [];
        req.user = {
            id: req.auth.sub,
            username: req.auth.preferred_username || req.auth.email || 'unknown',
            email: req.auth.email || '',
            roles: roles,
        };
        logger_1.default.info({ user: req.user.username, path: req.path, method: req.method }, 'Authenticated user mapped from Keycloak JWT');
    }
    next();
};
// Simulated Auth Middleware
const checkJwtSimulated = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ success: false, message: 'Authentication required (Simulation mode active. Use Bearer super_admin, Bearer group_admin, or Bearer user)' });
        return;
    }
    const token = authHeader.split(' ')[1];
    if (token === 'super_admin') {
        req.user = {
            id: 'super-admin-uuid-1111',
            username: 'Mayank_Aggarwal',
            email: 'mayank@bachatt.com',
            roles: ['atlas_super_admin', 'atlas_user'],
        };
    }
    else if (token === 'group_admin') {
        req.user = {
            id: 'group-admin-uuid-2222',
            username: 'Yogesh_Verma',
            email: 'yogesh@bachatt.com',
            roles: ['atlas_group_admin', 'atlas_user'],
        };
    }
    else {
        // Default or user
        req.user = {
            id: 'regular-user-uuid-3333',
            username: 'Rishit_Goel',
            email: 'rishit@bachatt.com',
            roles: ['atlas_user'],
        };
    }
    logger_1.default.debug({ user: req.user.username, roles: req.user.roles, path: req.path }, 'Authenticated via Simulation mode');
    next();
};
const handleJwtError = (err, req, res, next) => {
    if (err.name === 'UnauthorizedError') {
        logger_1.default.warn({ path: req.path, method: req.method, error: err.message }, 'Invalid token access attempt');
        res.status(401).json({
            success: false,
            message: err.message,
        });
    }
    else {
        next(err);
    }
};
// Main middleware array export
const useSimulation = process.env.KEYCLOAK_SIMULATION === 'true' || process.env.NODE_ENV === 'development';
exports.authenticateToken = useSimulation
    ? [checkJwtSimulated]
    : [checkJwtLive, mapLiveKeycloakUser, handleJwtError];
// Enforce role checks
const requireRole = (requiredRoles) => {
    return (req, res, next) => {
        if (!req.user || !req.user.roles) {
            logger_1.default.warn({ path: req.path }, 'Role check failed - no user found');
            res.status(401).json({ success: false, message: 'Authentication required' });
            return;
        }
        const userRoles = req.user?.roles ?? [];
        const hasRole = requiredRoles.some(role => userRoles.includes(role));
        if (!hasRole) {
            logger_1.default.warn({ user: req.user.username, required: requiredRoles, actual: req.user.roles }, 'Insufficient permissions');
            res.status(403).json({ success: false, message: 'Insufficient permissions' });
            return;
        }
        next();
    };
};
exports.requireRole = requireRole;
