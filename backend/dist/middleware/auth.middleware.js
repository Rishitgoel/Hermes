"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkIsGroupAdmin = exports.getAdminGroupSlugsFromRoles = exports.requireRole = exports.authenticateToken = void 0;
const express_jwt_1 = require("express-jwt");
const jwks_rsa_1 = __importDefault(require("jwks-rsa"));
const logger_1 = __importDefault(require("../utils/logger"));
const config_1 = __importDefault(require("../config/config"));
const checkJwtLive = (0, express_jwt_1.expressjwt)({
    secret: jwks_rsa_1.default.expressJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: config_1.default.keycloak.jwksUri,
    }),
    algorithms: ['RS256'],
    issuer: config_1.default.keycloak.issuer,
    ...(config_1.default.keycloak.audience ? { audience: config_1.default.keycloak.audience } : {}),
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
            email: 'mayank.aggarwal@bachatt.app',
            roles: ['atlas_super_admin', 'atlas_user'],
        };
    }
    else if (token === 'group_admin') {
        req.user = {
            id: 'group-admin-uuid-2222',
            username: 'Yogesh_Verma',
            email: 'yogesh.verma@bachatt.app',
            roles: ['atlas_group_admin', 'atlas_group_admin_growth', 'atlas_user'],
        };
    }
    else {
        // Default or user
        req.user = {
            id: 'regular-user-uuid-3333',
            username: 'Rishit_Goel',
            email: 'rishit.goel@bachatt.app',
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
const useSimulation = config_1.default.isSimulation;
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
const getAdminGroupSlugsFromRoles = (userRoles) => {
    const prefixes = ['atlas_group_admin_', 'group_admin_'];
    const slugs = [];
    for (const role of userRoles) {
        const lowerRole = role.toLowerCase();
        for (const prefix of prefixes) {
            if (lowerRole.startsWith(prefix)) {
                const slug = lowerRole.substring(prefix.length).replace(/_/g, '-');
                slugs.push(slug);
            }
        }
    }
    return slugs;
};
exports.getAdminGroupSlugsFromRoles = getAdminGroupSlugsFromRoles;
const checkIsGroupAdmin = (userRoles, groupSlug) => {
    const normalizedSlug = groupSlug.toLowerCase();
    const underscoreSlug = normalizedSlug.replace(/-/g, '_');
    const possibleRoles = [
        `atlas_group_admin_${normalizedSlug}`,
        `atlas_group_admin_${underscoreSlug}`,
        `group_admin_${normalizedSlug}`,
        `group_admin_${underscoreSlug}`
    ];
    return userRoles.some(role => possibleRoles.includes(role.toLowerCase()));
};
exports.checkIsGroupAdmin = checkIsGroupAdmin;
