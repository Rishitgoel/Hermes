import { Request, Response, NextFunction } from 'express';
import { expressjwt, GetVerificationKey } from 'express-jwt';
import jwksRsa from 'jwks-rsa';
import logger from '../utils/logger';

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
    jwksUri: process.env.KEYCLOAK_JWKS_URI || 'https://keycloak.bachatt.app/realms/master/protocol/openid-connect/certs',
  }) as GetVerificationKey,
  algorithms: ['RS256'],
  issuer: process.env.KEYCLOAK_ISSUER || 'https://keycloak.bachatt.app/realms/master',
  audience: process.env.KEYCLOAK_AUDIENCE || 'atlas-prod',
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
  } else if (token === 'group_admin') {
    req.user = {
      id: 'group-admin-uuid-2222',
      username: 'Yogesh_Verma',
      email: 'yogesh@bachatt.com',
      roles: ['atlas_group_admin', 'atlas_user'],
    };
  } else {
    // Default or user
    req.user = {
      id: 'regular-user-uuid-3333',
      username: 'Rishit_Goel',
      email: 'rishit@bachatt.com',
      roles: ['atlas_user'],
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
    res.status(401).json({
      success: false,
      message: err.message,
    });
  } else {
    next(err);
  }
};

// Main middleware array export
const useSimulation = process.env.KEYCLOAK_SIMULATION === 'true' || process.env.NODE_ENV === 'development';

export const authenticateToken = useSimulation
  ? [checkJwtSimulated]
  : [checkJwtLive, mapLiveKeycloakUser, handleJwtError];

// Enforce role checks
export const requireRole = (requiredRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !req.user.roles) {
      logger.warn({ path: req.path }, 'Role check failed - no user found');
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }

    const userRoles = req.user?.roles ?? [];
    const hasRole = requiredRoles.some(role => userRoles.includes(role));

    if (!hasRole) {
      logger.warn(
        { user: req.user.username, required: requiredRoles, actual: req.user.roles },
        'Insufficient permissions',
      );
      res.status(403).json({ success: false, message: 'Insufficient permissions' });
      return;
    }

    next();
  };
};
