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
      roles: ['hermes_group_admin', 'hermes_group_admin_redash_growth', 'hermes_user'],
    };
  } else if (token === 'platform_admin') {
    req.user = {
      id: 'platform-admin-uuid-4444',
      username: 'Neha_Sharma',
      email: 'neha.sharma@bachatt.app',
      roles: ['hermes_platform_admin', 'hermes_platform_admin_redash', 'hermes_user'],
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

// NOTE (mirror-authoritative model): as of the immediate-revocation change, the
// authorization helpers in utils/authz.ts no longer consult JWT scoped roles — a
// user is a platform/group admin iff a mirror row exists. The role-parsing helpers
// below (getAdminGroupSlugsFromRoles, checkIsGroupAdmin, checkIsPlatformAdmin,
// getPlatformAdminPlatformsFromRoles) are retained for back-compat and the cosmetic
// group-list "admin" badge (group.controller) only — do NOT reintroduce them into
// authorization decisions.
//
// Parsing edge: a legacy slug-only role whose slug itself begins with a known
// platform-key token (e.g. slug "redash-foo" → role hermes_group_admin_redash_foo)
// is ambiguously parsed as platform=redash/slug=foo. Acceptable — legacy roles are
// migrated away and this path no longer gates authorization.
//
// Extract the group slugs a user administers from their realm roles.
//
// Two role-name formats are recognised:
//   - New, platform-qualified:  hermes_group_admin_<platform>_<slug>
//     (e.g. hermes_group_admin_redash_growth) — the slug keeps its hyphens.
//   - Legacy, slug-only:        hermes_group_admin_<slug>
//     (e.g. hermes_group_admin_growth; hyphens were encoded as underscores).
//
// `knownPlatforms` (from the provisioning registry) disambiguates the two: if
// the part after the prefix begins with a known platform key + "_", we strip it
// and treat the remainder as the (hyphenated) slug; otherwise we fall back to
// the legacy underscore-decoded form. Platform keys are single lowercase tokens
// with no underscores, so the split is unambiguous.
export const getAdminGroupSlugsFromRoles = (
  userRoles: string[],
  knownPlatforms: string[] = [],
): string[] => {
  const prefixes = ['hermes_group_admin_', 'group_admin_'];
  const platforms = knownPlatforms.map(p => p.toLowerCase());
  const slugs: string[] = [];

  for (const role of userRoles) {
    const lowerRole = role.toLowerCase();
    for (const prefix of prefixes) {
      if (lowerRole.startsWith(prefix)) {
        const rest = lowerRole.substring(prefix.length);
        const platform = platforms.find(p => rest.startsWith(`${p}_`));
        if (platform) {
          slugs.push(rest.substring(platform.length + 1)); // slug already hyphenated
        } else {
          slugs.push(rest.replace(/_/g, '-')); // legacy slug-only form
        }
        break;
      }
    }
  }
  return slugs;
};

// Check whether the user holds the group-admin role for a given group. We have
// the group's slug + platform here, so we just build the candidate role names
// and look for any of them — no parsing needed. Both the new platform-qualified
// name and the legacy slug-only names are accepted (back-compat during/after the
// migration). `platform` is optional so legacy callers still work.
export const checkIsGroupAdmin = (
  userRoles: string[],
  groupSlug: string,
  platform?: string,
): boolean => {
  const slug = groupSlug.toLowerCase();
  const underscoreSlug = slug.replace(/-/g, '_');

  const possibleRoles: string[] = [];
  if (platform) {
    const p = platform.toLowerCase();
    // New platform-qualified format (slug keeps hyphens; also accept underscore variant).
    possibleRoles.push(
      `hermes_group_admin_${p}_${slug}`,
      `hermes_group_admin_${p}_${underscoreSlug}`,
      `group_admin_${p}_${slug}`,
      `group_admin_${p}_${underscoreSlug}`,
    );
  }
  // Legacy slug-only format.
  possibleRoles.push(
    `hermes_group_admin_${slug}`,
    `hermes_group_admin_${underscoreSlug}`,
    `group_admin_${slug}`,
    `group_admin_${underscoreSlug}`,
  );

  return userRoles.some(role => possibleRoles.includes(role.toLowerCase()));
};

// Platform-admin role naming mirrors group-admin: a scoped realm role
// `hermes_platform_admin_<platform>` (e.g. hermes_platform_admin_redash).
// Platform keys are simple lowercase tokens (matching Group.platform and the
// provisioning registry), so no hyphen/underscore juggling is needed.
export const getPlatformAdminPlatformsFromRoles = (userRoles: string[]): string[] => {
  const prefixes = ['hermes_platform_admin_', 'platform_admin_'];
  const platforms: string[] = [];

  for (const role of userRoles) {
    const lowerRole = role.toLowerCase();
    for (const prefix of prefixes) {
      if (lowerRole.startsWith(prefix)) {
        platforms.push(lowerRole.substring(prefix.length));
      }
    }
  }
  return platforms;
};

export const checkIsPlatformAdmin = (userRoles: string[], platform: string): boolean => {
  const p = platform.toLowerCase();
  const possibleRoles = [`hermes_platform_admin_${p}`, `platform_admin_${p}`];
  return userRoles.some(role => possibleRoles.includes(role.toLowerCase()));
};
