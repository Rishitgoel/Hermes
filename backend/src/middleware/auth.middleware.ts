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
      error: 'Authentication required (Simulation mode active. Use Bearer super_admin, Bearer group_admin, or Bearer user)',
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
      roles: ['hermes_group_admin', 'hermes_group_admin_growth', 'hermes_user'],
    };
  } else {
    // Default or user
    req.user = {
      id: 'regular-user-uuid-3333',
      username: 'Rishit_Goel',
      email: 'rishit.goel@bachatt.app',
      roles: ['hermes_user'],
    };
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

export const getAdminGroupSlugsFromRoles = (userRoles: string[]): string[] => {
  const prefixes = ['hermes_group_admin_', 'group_admin_'];
  const slugs: string[] = [];
  
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

export const checkIsGroupAdmin = (userRoles: string[], groupSlug: string): boolean => {
  const normalizedSlug = groupSlug.toLowerCase();
  const underscoreSlug = normalizedSlug.replace(/-/g, '_');
  
  const possibleRoles = [
    `hermes_group_admin_${normalizedSlug}`,
    `hermes_group_admin_${underscoreSlug}`,
    `group_admin_${normalizedSlug}`,
    `group_admin_${underscoreSlug}`
  ];
  
  return userRoles.some(role => possibleRoles.includes(role.toLowerCase()));
};
