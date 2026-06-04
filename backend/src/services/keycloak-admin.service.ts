import axios from 'axios';
import config from '../config/config';
import logger from '../utils/logger';
import { ExternalServiceError } from '../utils/errors';

interface RoleRepresentation {
  id: string;
  name: string;
  composite?: boolean;
  clientRole?: boolean;
  containerId?: string;
}

/**
 * Thin wrapper over the Keycloak Admin REST API for managing realm roles and
 * their user mappings. Hermes is the assignment UI for the platform_admin and
 * group_admin tiers; this service is how those assignments reach Keycloak — the
 * source of truth for what ends up in a user's JWT.
 *
 * In simulation mode — or any time the Keycloak admin credential is missing —
 * every mutating method becomes a logged no-op so local dev works without
 * Keycloak running. Callers maintain the DB mirror (GroupAdmin / PlatformAdmin)
 * regardless; this service only ever touches Keycloak.
 *
 * NOTE: a realm-role change only reaches a user's JWT on their next token
 * refresh / re-login — assignments are not instant for already-logged-in users.
 */
class KeycloakAdminService {
  private tokenCache: { token: string; expiresAt: number } | null = null;

  /** True when we can actually talk to Keycloak (live mode + a credential). */
  get isLive(): boolean {
    return !config.isSimulation && !!config.keycloak.adminPassword;
  }

  /**
   * True if we're live AND can currently obtain an admin token. Lets callers
   * (e.g. reconciliation) bail out once on an outage instead of failing every
   * sub-request. Uses the cached token, so it's cheap.
   */
  async canConnect(): Promise<boolean> {
    if (!this.isLive) return false;
    return (await this.getToken()) !== null;
  }

  private get base(): string {
    return `${config.keycloak.adminUrl}/admin/realms/${config.keycloak.realm}`;
  }

  private async getToken(): Promise<string | null> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 5000) {
      return this.tokenCache.token;
    }
    try {
      const tokenUrl = `${config.keycloak.adminUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/token`;
      const res = await axios.post(
        tokenUrl,
        new URLSearchParams({
          grant_type: 'password',
          client_id: config.keycloak.adminClientId,
          username: config.keycloak.adminUsername,
          password: config.keycloak.adminPassword || '',
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      const token = res.data.access_token as string;
      const expiresIn = (res.data.expires_in as number) ?? 60;
      this.tokenCache = { token, expiresAt: Date.now() + expiresIn * 1000 };
      return token;
    } catch (err: any) {
      logger.warn(`Keycloak admin: failed to obtain token: ${err.message}`);
      return null;
    }
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken();
    if (!token) {
      throw new ExternalServiceError('Could not authenticate with the Keycloak Admin API');
    }
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  /** Fetch a realm role representation, or null if it doesn't exist. */
  async getRealmRole(roleName: string): Promise<RoleRepresentation | null> {
    if (!this.isLive) return null;
    try {
      const headers = await this.authHeaders();
      const res = await axios.get(`${this.base}/roles/${encodeURIComponent(roleName)}`, { headers });
      return res.data as RoleRepresentation;
    } catch (err: any) {
      if (err.response?.status === 404) return null;
      throw err;
    }
  }

  /** Create a realm role if missing. Returns its representation (null in sim). */
  async ensureRealmRole(roleName: string, description?: string): Promise<RoleRepresentation | null> {
    if (!this.isLive) return null;
    const existing = await this.getRealmRole(roleName);
    if (existing) return existing;
    const headers = await this.authHeaders();
    await axios.post(
      `${this.base}/roles`,
      { name: roleName, description: description ?? `Hermes role ${roleName}` },
      { headers },
    );
    logger.info(`Keycloak admin: created realm role "${roleName}"`);
    return this.getRealmRole(roleName);
  }

  /**
   * Ensure `scopedRole` exists and is a composite that includes `markerRole`,
   * so granting the scoped role also carries the blanket marker in the JWT
   * (e.g. hermes_group_admin_growth ⊃ hermes_group_admin). Idempotent.
   */
  async ensureCompositeRole(scopedRole: string, markerRole: string, description?: string): Promise<void> {
    if (!this.isLive) return;
    await this.ensureRealmRole(markerRole);
    await this.ensureRealmRole(scopedRole, description);
    const marker = await this.getRealmRole(markerRole);
    if (!marker) return;
    const headers = await this.authHeaders();
    // Adding a composite that's already present is a harmless no-op (204).
    await axios.post(
      `${this.base}/roles/${encodeURIComponent(scopedRole)}/composites`,
      [marker],
      { headers },
    );
  }

  /** Assign a realm role to a user. Idempotent; no-op in sim. */
  async assignRealmRole(userId: string, roleName: string): Promise<void> {
    if (!this.isLive) {
      logger.info(`Keycloak admin (sim): would assign role "${roleName}" to user ${userId}`);
      return;
    }
    const role = await this.getRealmRole(roleName);
    if (!role) throw new ExternalServiceError(`Keycloak role "${roleName}" not found`);
    const headers = await this.authHeaders();
    await axios.post(
      `${this.base}/users/${encodeURIComponent(userId)}/role-mappings/realm`,
      [role],
      { headers },
    );
  }

  /** Remove a realm role from a user. Idempotent; no-op in sim. */
  async removeRealmRole(userId: string, roleName: string): Promise<void> {
    if (!this.isLive) {
      logger.info(`Keycloak admin (sim): would remove role "${roleName}" from user ${userId}`);
      return;
    }
    const role = await this.getRealmRole(roleName);
    if (!role) return;
    const headers = await this.authHeaders();
    await axios.delete(`${this.base}/users/${encodeURIComponent(userId)}/role-mappings/realm`, {
      headers,
      data: [role],
    });
  }

  /**
   * Terminate all of a user's Keycloak sessions, forcing re-authentication on their
   * next refresh/login. Used after revoking an admin role as defense-in-depth: it
   * clears the dropped role from the user's *future* tokens. It does NOT invalidate an
   * already-issued access token (those are stateless and self-validating until they
   * expire) — immediate revocation comes from deleting the DB mirror row, which the
   * mirror-authoritative authz (utils/authz.ts) checks on the next request. Best-effort:
   * never throws (a failed logout must not fail the surrounding removal); no-op in simulation.
   */
  async logoutUser(userId: string): Promise<void> {
    if (!this.isLive) {
      logger.info(`Keycloak admin (sim): would terminate sessions for user ${userId}`);
      return;
    }
    try {
      const headers = await this.authHeaders();
      await axios.post(`${this.base}/users/${encodeURIComponent(userId)}/logout`, {}, { headers });
      logger.info(`Keycloak admin: terminated sessions for user ${userId} (immediate role revocation)`);
    } catch (err: any) {
      if (err.response?.status === 404) return; // user gone — nothing to log out
      logger.warn(`Keycloak admin: failed to terminate sessions for user ${userId}: ${err.message}`);
    }
  }

  /** Fetch a user representation (username/email/...) by id, or null. */
  async getUser(userId: string): Promise<{ id: string; username?: string; email?: string; firstName?: string; lastName?: string } | null> {
    if (!this.isLive) return null;
    try {
      const headers = await this.authHeaders();
      const res = await axios.get(`${this.base}/users/${encodeURIComponent(userId)}`, { headers });
      return res.data;
    } catch (err: any) {
      if (err.response?.status === 404) return null;
      throw err;
    }
  }

  /** Keycloak user IDs holding a given realm role. Empty when not live. */
  async getUsersInRole(roleName: string): Promise<string[]> {
    if (!this.isLive) return [];
    try {
      const headers = await this.authHeaders();
      const res = await axios.get(`${this.base}/roles/${encodeURIComponent(roleName)}/users`, {
        headers,
        params: { max: 500 },
      });
      const users: any[] = Array.isArray(res.data) ? res.data : [];
      return users.map((u) => u.id).filter((id): id is string => typeof id === 'string');
    } catch (err: any) {
      if (err.response?.status === 404) return [];
      throw err;
    }
  }
}

export const keycloakAdminService = new KeycloakAdminService();
export default keycloakAdminService;
