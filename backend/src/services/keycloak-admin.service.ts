import axios from 'axios';
import config from '../config/config';
import logger from '../utils/logger';
import { ConflictError, ExternalServiceError } from '../utils/errors';

interface RoleRepresentation {
  id: string;
  name: string;
  composite?: boolean;
  clientRole?: boolean;
  containerId?: string;
}

export interface CreateKeycloakUserInput {
  email: string;
  username: string;
  firstName?: string;
  lastName?: string;
  /** Plaintext password stored as a TEMPORARY credential (forces reset at first login). */
  temporaryPassword: string;
}

/**
 * True for Keycloak's own privileged built-ins — the ones that administer
 * Keycloak itself.
 *
 * Used to refuse acting on an account that outranks the caller: a
 * hermes_super_admin cannot be granted these roles, so they must not be able to
 * take over an account that holds one either.
 */
export function isPrivilegedRealmRole(roleName: string): boolean {
  const name = roleName.toLowerCase();
  return name === 'admin' || name === 'create-realm' || name === 'realm-admin';
}

/**
 * Bound every Keycloak Admin API call. Raw axios has NO default timeout, so an
 * unresponsive Keycloak would otherwise hold an Express request open until the
 * socket eventually dies. Matches `createHttpClient`'s default.
 */
const KEYCLOAK_TIMEOUT_MS = 10_000;

/**
 * Worth retrying: the request never got a considered answer. A network error, a
 * client-side timeout, or a 5xx. Explicitly NOT 4xx — a 400/403/404/409 is a
 * decision Keycloak made and repeating the call just repeats it.
 */
function isTransientKeycloakError(err: any): boolean {
  if (err?.code === 'ECONNABORTED') {
    return true;
  }
  if (!err?.response) {
    return true;
  }
  return err.response.status >= 500;
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
    if (!this.isLive) {return false;}
    return (await this.getToken()) !== null;
  }

  private get base(): string {
    return `${config.keycloak.adminUrl}/admin/realms/${config.keycloak.realm}`;
  }

  /**
   * Retry an idempotent Keycloak call through transient failures with
   * exponential backoff, and recover once from an expired token.
   *
   * The 401 case is not theoretical: the token cache trusts `expires_in`, so a
   * Keycloak restart or an admin-session revocation invalidates a token we still
   * believe is good. Dropping the cache and re-authenticating once turns that
   * from a hard failure into a hiccup.
   *
   * ONLY for calls that are safe to repeat — reads, and role mappings (adding an
   * existing mapping is a Keycloak no-op). Creating a user is NOT safe to repeat
   * and is handled separately in `createUser`.
   */
  private async withRetry<T>(
    op: string,
    fn: () => Promise<T>,
    attempts = 3,
  ): Promise<T> {
    let lastErr: any;
    let reauthed = false;

    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;

        // Stale token → drop the cache and retry immediately, once.
        if (err?.response?.status === 401 && !reauthed) {
          reauthed = true;
          this.tokenCache = null;
          logger.warn(
            { op },
            'Keycloak admin: token rejected (401) — re-authenticating and retrying once',
          );
          continue;
        }

        if (!isTransientKeycloakError(err) || i === attempts - 1) {
          throw err;
        }

        const delayMs = 300 * Math.pow(2, i);
        logger.warn(
          { op, attempt: i + 1, delayMs, error: err.message },
          'Keycloak admin: transient error, retrying',
        );
        await new Promise(res => setTimeout(res, delayMs));
      }
    }
    throw lastErr;
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
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          // Every other call funnels through here, so an unbounded hang on the
          // token endpoint would stall all of them.
          timeout: KEYCLOAK_TIMEOUT_MS,
        },
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
      throw new ExternalServiceError(
        'Could not authenticate with the Keycloak Admin API',
      );
    }
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  /** Fetch a realm role representation, or null if it doesn't exist. */
  async getRealmRole(roleName: string): Promise<RoleRepresentation | null> {
    if (!this.isLive) {return null;}
    try {
      const headers = await this.authHeaders();
      const res = await axios.get(
        `${this.base}/roles/${encodeURIComponent(roleName)}`,
        { headers },
      );
      return res.data as RoleRepresentation;
    } catch (err: any) {
      if (err.response?.status === 404) {return null;}
      throw err;
    }
  }

  /** Create a realm role if missing. Returns its representation (null in sim). */
  async ensureRealmRole(
    roleName: string,
    description?: string,
  ): Promise<RoleRepresentation | null> {
    if (!this.isLive) {return null;}
    const existing = await this.getRealmRole(roleName);
    if (existing) {return existing;}
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
  async ensureCompositeRole(
    scopedRole: string,
    markerRole: string,
    description?: string,
  ): Promise<void> {
    if (!this.isLive) {return;}
    await this.ensureRealmRole(markerRole);
    await this.ensureRealmRole(scopedRole, description);
    const marker = await this.getRealmRole(markerRole);
    if (!marker) {return;}
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
      logger.info(
        `Keycloak admin (sim): would assign role "${roleName}" to user ${userId}`,
      );
      return;
    }
    const role = await this.getRealmRole(roleName);
    if (!role)
      {throw new ExternalServiceError(`Keycloak role "${roleName}" not found`);}
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
      logger.info(
        `Keycloak admin (sim): would remove role "${roleName}" from user ${userId}`,
      );
      return;
    }
    const role = await this.getRealmRole(roleName);
    if (!role) {return;}
    const headers = await this.authHeaders();
    await axios.delete(
      `${this.base}/users/${encodeURIComponent(userId)}/role-mappings/realm`,
      {
        headers,
        data: [role],
      },
    );
  }

  /** All realm roles (name + composite flag). Empty when not live. */
  async listRealmRoles(): Promise<RoleRepresentation[]> {
    if (!this.isLive) {return [];}
    const headers = await this.authHeaders();
    const res = await axios.get(`${this.base}/roles`, {
      headers,
      params: { max: 2000 },
    });
    return Array.isArray(res.data) ? (res.data as RoleRepresentation[]) : [];
  }

  /** Delete a realm role by name. No-op in sim or if it doesn't exist. */
  async deleteRealmRole(roleName: string): Promise<void> {
    if (!this.isLive) {
      logger.info(`Keycloak admin (sim): would delete role "${roleName}"`);
      return;
    }
    try {
      const headers = await this.authHeaders();
      await axios.delete(`${this.base}/roles/${encodeURIComponent(roleName)}`, {
        headers,
      });
    } catch (err: any) {
      if (err.response?.status === 404) {return;}
      throw err;
    }
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
      logger.info(
        `Keycloak admin (sim): would terminate sessions for user ${userId}`,
      );
      return;
    }
    try {
      const headers = await this.authHeaders();
      await axios.post(
        `${this.base}/users/${encodeURIComponent(userId)}/logout`,
        {},
        { headers },
      );
      logger.info(
        `Keycloak admin: terminated sessions for user ${userId} (immediate role revocation)`,
      );
    } catch (err: any) {
      if (err.response?.status === 404) {return;} // user gone — nothing to log out
      logger.warn(
        `Keycloak admin: failed to terminate sessions for user ${userId}: ${err.message}`,
      );
    }
  }

  /** Fetch a user representation (username/email/...) by id, or null. */
  async getUser(
    userId: string,
  ): Promise<{
    id: string;
    username?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
  } | null> {
    if (!this.isLive) {return null;}
    try {
      const headers = await this.authHeaders();
      const res = await axios.get(
        `${this.base}/users/${encodeURIComponent(userId)}`,
        { headers },
      );
      return res.data;
    } catch (err: any) {
      if (err.response?.status === 404) {return null;}
      throw err;
    }
  }

  /**
   * Resolve a user's Keycloak id ('sub') from their email — the identity Hermes
   * keys grants and account-creation requests on. Returns null in sim, on no
   * match, or on error (callers treat that as "no Hermes identity for this
   * person"). Used by the one-shot Redash membership import to attach imported
   * grants to the right user. Exact, case-insensitive match.
   */
  async findUserIdByEmail(email: string): Promise<string | null> {
    if (!this.isLive) {return null;}
    try {
      // Retried: `createUser`'s recovery path relies on this to decide whether a
      // failed-looking create actually landed. A transient blip returning a false
      // "not found" there would re-issue the create against an account that
      // already exists.
      return await this.withRetry('findUserIdByEmail', async () => {
        const headers = await this.authHeaders();
        const res = await axios.get(`${this.base}/users`, {
          headers,
          params: { email, exact: true },
          timeout: KEYCLOAK_TIMEOUT_MS,
        });
        const users: Array<{ id: string; email?: string }> = Array.isArray(
          res.data,
        )
          ? res.data
          : [];
        const match =
          users.find(
            u => (u.email || '').toLowerCase() === email.toLowerCase(),
          ) ?? users[0];
        return match?.id ?? null;
      });
    } catch (err: any) {
      logger.warn(
        `Keycloak admin: findUserIdByEmail failed for ${email}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Create a realm user with a temporary password, in a single Admin API call.
   * Returns the new user's Keycloak id.
   *
   * The password is passed inline as a `temporary: true` credential rather than
   * being set in a follow-up request, so there is no window in which the account
   * exists without one. `temporary: true` is what makes Keycloak challenge the
   * user to choose a new password before it will issue a token; UPDATE_PASSWORD
   * is *also* set explicitly on the representation because that derivation has
   * historically varied between Keycloak versions, and the difference between the
   * two behaviours is "must reset at first login" vs "keeps this password
   * forever".
   *
   * `emailVerified: true` is deliberate: the address is vouched for by the super
   * admin creating the account, and leaving it false would make Keycloak demand a
   * verification email — which Hermes does not send for this flow.
   *
   * Throws ConflictError if the username or email is already taken.
   *
   * NOT retried blindly. A create is the one call here that isn't safe to repeat:
   * if the request reached Keycloak and only the *response* was lost, a second
   * attempt returns 409 and the caller is told "already exists" about an account
   * it just made itself — with the password undelivered. So a transient failure
   * first asks Keycloak whether the account actually landed, adopts it if so, and
   * only re-issues the create when it definitively did not.
   */
  async createUser(input: CreateKeycloakUserInput): Promise<string> {
    if (!this.isLive) {
      logger.info(
        { email: input.email, username: input.username },
        '🌱 Simulating Keycloak user creation (simulation mode active)',
      );
      return `sim-keycloak-user-${Date.now()}`;
    }

    const attemptCreate = async (): Promise<string | undefined> => {
      const headers = await this.authHeaders();
      const res = await axios.post(
        `${this.base}/users`,
        {
          username: input.username,
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          enabled: true,
          emailVerified: true,
          requiredActions: ['UPDATE_PASSWORD'],
          credentials: [
            {
              type: 'password',
              value: input.temporaryPassword,
              temporary: true,
            },
          ],
        },
        { headers, timeout: KEYCLOAK_TIMEOUT_MS },
      );
      return res.headers?.location as string | undefined;
    };

    const MAX_CREATE_ATTEMPTS = 2;
    let location: string | undefined;

    for (let attempt = 1; ; attempt++) {
      try {
        location = await attemptCreate();
        break;
      } catch (err: any) {
        if (err.response?.status === 409) {
          throw new ConflictError(
            `A Keycloak user with this email or username already exists (${input.email})`,
          );
        }

        if (isTransientKeycloakError(err) && attempt < MAX_CREATE_ATTEMPTS) {
          // Did the create actually land before the connection broke? If it did,
          // re-issuing would 409 against our own account.
          const landed = await this.findUserIdByEmail(input.email);
          if (landed) {
            logger.warn(
              { email: input.email, userId: landed, error: err.message },
              'Keycloak admin: create appeared to fail but the account exists — adopting it instead of retrying',
            );
            return landed;
          }
          logger.warn(
            { email: input.email, attempt, error: err.message },
            'Keycloak admin: transient error on user create and no account was written — retrying',
          );
          await new Promise(res => setTimeout(res, 300 * attempt));
          continue;
        }

        // 400 here is usually the realm's password policy rejecting the generated
        // password — surface Keycloak's own message, it names the failing rule.
        const detail =
          err.response?.data?.errorMessage ||
          err.response?.data?.error ||
          err.message;
        throw new ExternalServiceError(
          `Keycloak rejected the user creation: ${detail}`,
        );
      }
    }

    // 201 Created carries the new id in the Location header. Some proxies strip
    // it, so fall back to an email lookup rather than failing a user that was in
    // fact created.
    const rawId = location?.split('/').filter(Boolean).pop();
    const idFromLocation = rawId ? rawId.split('?')[0].split('#')[0] : undefined;
    if (idFromLocation) {
      return idFromLocation;
    }

    const resolved = await this.findUserIdByEmail(input.email);
    if (!resolved) {
      // The account was accepted by Keycloak but we cannot name it, so we can
      // neither finish provisioning nor roll it back (deleting needs the very id
      // we're missing). Say so explicitly: the caller must know an orphan may
      // exist, or they will retry, hit a 409, and have no idea why.
      logger.error(
        { email: input.email, username: input.username },
        'Keycloak accepted the user creation but its id could not be resolved — a partially-provisioned account may exist',
      );
      throw new ExternalServiceError(
        `Keycloak accepted the account for ${input.email} but did not return its id, so provisioning could not be completed. ` +
          `A user "${input.username}" may now exist in Keycloak with no password delivered — check the realm and delete it before retrying.`,
      );
    }
    return resolved;
  }

  /**
   * EFFECTIVE realm role names held by a user. Used as a safety guard before a
   * password reset — see `apollo-user.service.regeneratePassword`. Empty when not
   * live.
   *
   * Deliberately the `/composite` endpoint, not the plain one: Hermes itself
   * builds composite roles (see `ensureCompositeRole`), so a privileged role
   * reached *through* a composite is entirely possible. The plain endpoint returns
   * only direct assignments and would let exactly that case slip past the guard.
   */
  async getUserRealmRoles(userId: string): Promise<string[]> {
    if (!this.isLive) {
      return [];
    }
    return this.withRetry('getUserRealmRoles', async () => {
      const headers = await this.authHeaders();
      const res = await axios.get(
        `${this.base}/users/${encodeURIComponent(userId)}/role-mappings/realm/composite`,
        { headers, timeout: KEYCLOAK_TIMEOUT_MS },
      );
      const roles: RoleRepresentation[] = Array.isArray(res.data) ? res.data : [];
      return roles.map(r => r.name).filter((n): n is string => !!n);
    });
  }

  /**
   * Replace a user's password with a new TEMPORARY one, forcing them to choose a
   * fresh password at their next login. Invalidates whatever password they had.
   *
   * Safe to retry: the call is a PUT carrying the full desired state, so a repeat
   * after a lost response simply sets the same password again.
   */
  async resetPassword(userId: string, temporaryPassword: string): Promise<void> {
    if (!this.isLive) {
      throw new ExternalServiceError(
        'Keycloak is running in simulation mode — cannot reset a real password.',
      );
    }

    await this.withRetry('resetPassword', async () => {
      const headers = await this.authHeaders();
      await axios.put(
        `${this.base}/users/${encodeURIComponent(userId)}/reset-password`,
        { type: 'password', value: temporaryPassword, temporary: true },
        { headers, timeout: KEYCLOAK_TIMEOUT_MS },
      );
    });

    // `temporary: true` above is what normally adds UPDATE_PASSWORD, but that
    // derivation has varied between Keycloak versions and the difference is
    // "must reset at next login" vs "keeps this password forever". Re-assert it
    // explicitly, merging rather than replacing so any other pending required
    // action (e.g. CONFIGURE_TOTP) survives.
    //
    // Best-effort: the reset itself already succeeded, and failing the whole
    // operation here would strand a password that has already been changed.
    try {
      await this.withRetry('resetPassword:requiredAction', async () => {
        const headers = await this.authHeaders();
        const current = await axios.get(
          `${this.base}/users/${encodeURIComponent(userId)}`,
          { headers, timeout: KEYCLOAK_TIMEOUT_MS },
        );
        const actions: string[] = Array.isArray(current.data?.requiredActions)
          ? current.data.requiredActions
          : [];
        if (actions.includes('UPDATE_PASSWORD')) {
          return;
        }
        await axios.put(
          `${this.base}/users/${encodeURIComponent(userId)}`,
          {
            ...(current.data && typeof current.data === 'object' ? current.data : {}),
            requiredActions: [...actions, 'UPDATE_PASSWORD'],
          },
          { headers, timeout: KEYCLOAK_TIMEOUT_MS },
        );
      });
    } catch (err: any) {
      logger.warn(
        { userId, error: err.message },
        'Keycloak admin: password was reset but UPDATE_PASSWORD could not be re-asserted — the temporary credential should still force a reset',
      );
    }
  }

  /**
   * True if a username is already taken. Used to disambiguate a derived username
   * (First_Last) *before* creating the user, so a name collision becomes
   * "Rishit_Goel_2" rather than an opaque 409 the super admin can't act on.
   * Exact match; Keycloak compares usernames case-insensitively.
   */
  async usernameExists(username: string): Promise<boolean> {
    if (!this.isLive) {
      return false;
    }
    try {
      return await this.withRetry('usernameExists', async () => {
        const headers = await this.authHeaders();
        const res = await axios.get(`${this.base}/users`, {
          headers,
          params: { username, exact: true },
          timeout: KEYCLOAK_TIMEOUT_MS,
        });
        return Array.isArray(res.data) && res.data.length > 0;
      });
    } catch (err: any) {
      logger.warn(
        `Keycloak admin: usernameExists failed for ${username}: ${err.message}`,
      );
      // Unknown → assume free and let Keycloak's own 409 be the backstop.
      return false;
    }
  }

  /** Keycloak user IDs holding a given realm role. Empty when not live. */
  async getUsersInRole(roleName: string): Promise<string[]> {
    if (!this.isLive) {return [];}
    try {
      const headers = await this.authHeaders();
      const res = await axios.get(
        `${this.base}/roles/${encodeURIComponent(roleName)}/users`,
        {
          headers,
          params: { max: 500 },
        },
      );
      const users: any[] = Array.isArray(res.data) ? res.data : [];
      return users
        .map(u => u.id)
        .filter((id): id is string => typeof id === 'string');
    } catch (err: any) {
      if (err.response?.status === 404) {return [];}
      throw err;
    }
  }
}

export const keycloakAdminService = new KeycloakAdminService();
export default keycloakAdminService;
