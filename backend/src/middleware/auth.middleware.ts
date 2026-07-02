import { Request, Response, NextFunction } from 'express';
import { expressjwt, GetVerificationKey } from 'express-jwt';
import jwksRsa from 'jwks-rsa';
import logger from '../utils/logger';

import config from '../config/config';

export interface AuthenticatedUser {
  id: string; // Keycloak 'sub'
  username: string; // Keycloak 'preferred_username'
  email: string;
  roles: string[];
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthenticatedUser;
    auth?: any; // Added by express-jwt
  }
}

// In production the audience claim MUST be validated — otherwise a token minted for
// any other client in the same Keycloak realm would be accepted here. Fail fast at
// boot rather than silently accepting cross-client tokens. (This module is imported
// after loadSecrets, so config.keycloak.audience reflects any injected secrets.)
if (config.isProd && !config.keycloak.audience) {
  throw new Error('KEYCLOAK_AUDIENCE is required in production (JWT audience validation).');
}

const checkJwtLive = expressjwt({
  secret: jwksRsa.expressJwtSecret({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5,
    jwksUri: config.keycloak.jwksUri,
  }) as GetVerificationKey,
  algorithms: ['RS256'],
  issuer: config.keycloak.issuer,
  ...(config.keycloak.audience ? { audience: config.keycloak.audience } : {}),
});

// Middleware for Live mapping
const mapLiveKeycloakUser = (req: Request, res: Response, next: NextFunction) => {
  if (req.auth) {
    const roles = req.auth.realm_access?.roles || [];
    req.user = {
      id: req.auth.sub,
      username: req.auth.preferred_username || req.auth.email || 'unknown',
      email: req.auth.email || '',
      roles: roles,
    };
    logger.info(
      { user: req.user.username, path: req.path, method: req.method },
      'Authenticated user mapped from Keycloak JWT',
    );
  }
  next();
};

// Simulated Auth Middleware
const checkJwtSimulated = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: 'Authentication required (Simulation mode active. Use Bearer super_admin, Bearer platform_admin, Bearer group_admin, or Bearer user)',
      metadata: {
        timestamp: new Date().toISOString(),
        errorCode: 'AUTHENTICATION_ERROR',
      },
    });
    return;
  }

  const token = authHeader.split(' ')[1];
  if (token === 'super_admin') {
    req.user = {
      id: 'super-admin-uuid-1111',
      username: 'Mayank_Aggarwal',
      email: 'mayank.aggarwal@bachatt.app',
      roles: ['hermes_super_admin', 'hermes_user'],
    };
  } else if (token === 'group_admin') {
    req.user = {
      id: 'group-admin-uuid-2222',
      username: 'Yogesh_Verma',
      email: 'yogesh.verma@bachatt.app',
      roles: ['hermes_group_admin', `hermes_group_admin_${config.platform.default}_growth`, 'hermes_user'],
    };
  } else if (token === 'platform_admin') {
    req.user = {
      id: 'platform-admin-uuid-4444',
      username: 'Neha_Sharma',
      email: 'neha.sharma@bachatt.app',
      roles: ['hermes_platform_admin', `hermes_platform_admin_${config.platform.default}`, 'hermes_user'],
    };
  } else if (token === 'user') {
    req.user = {
      id: 'regular-user-uuid-3333',
      username: 'Rishit_Goel',
      email: 'rishit.goel@bachatt.app',
      roles: ['hermes_user'],
    };
  } else {
    // Unknown sim token — reject. Previously this fell back to the regular user
    // identity, which silently authenticated any garbage bearer string.
    res.status(401).json({
      success: false,
      error: 'Invalid simulation token. Use Bearer super_admin, Bearer platform_admin, Bearer group_admin, or Bearer user.',
      metadata: {
        timestamp: new Date().toISOString(),
        errorCode: 'AUTHENTICATION_ERROR',
      },
    });
    return;
  }

  logger.debug(
    { user: req.user.username, roles: req.user.roles, path: req.path },
    'Authenticated via Simulation mode',
  );
  next();
};

const handleJwtError = (err: any, req: Request, res: Response, next: NextFunction) => {
  if (err.name === 'UnauthorizedError') {
    logger.warn(
      { path: req.path, method: req.method, error: err.message },
      'Invalid token access attempt',
    );
    // Distinguish expired vs malformed/invalid so the client can react
    // (e.g. the apiClient's 401 interceptor only retries after refresh).
    const isExpired = err.inner?.name === 'TokenExpiredError' || /expired/i.test(err.message || '');
    res.status(401).json({
      success: false,
      error: err.message,
      metadata: {
        timestamp: new Date().toISOString(),
        errorCode: isExpired ? 'TOKEN_EXPIRED' : 'AUTHENTICATION_ERROR',
      },
    });
  } else {
    next(err);
  }
};

// Main middleware array export
const useSimulation = config.isSimulation;

export const authenticateToken = useSimulation
  ? [checkJwtSimulated]
  : [checkJwtLive, mapLiveKeycloakUser, handleJwtError];

// EventSource (used by the SSE notification stream) cannot send custom headers, so
// the token rides in a `?token=` query param. Copy it into the Authorization header
// BEFORE the normal auth chain runs, so both the simulated and live (express-jwt)
// paths validate it exactly as a header-borne Bearer token — no duplicated auth logic.
// NOTE: this means the token appears in the request URL (and thus access logs) for the
// stream endpoint; acceptable for SSE, which has no header alternative.
export const injectQueryTokenAsHeader = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.headers.authorization && typeof req.query.token === 'string' && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
};

// Enforce role checks
export const requireRole = (requiredRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !req.user.roles) {
      logger.warn({ path: req.path }, 'Role check failed - no user found');
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        metadata: {
          timestamp: new Date().toISOString(),
          errorCode: 'AUTHENTICATION_ERROR',
        },
      });
      return;
    }

    const userRoles = req.user?.roles ?? [];
    const hasRole = requiredRoles.some(role => userRoles.includes(role));

    if (!hasRole) {
      logger.warn(
        { user: req.user.username, required: requiredRoles, actual: req.user.roles },
        'Insufficient permissions',
      );
      res.status(403).json({
        success: false,
        error: 'Insufficient permissions',
        metadata: {
          timestamp: new Date().toISOString(),
          errorCode: 'AUTHORIZATION_ERROR',
        },
      });
      return;
    }

    next();
  };
};
