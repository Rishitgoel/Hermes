import {
  IdentitystoreClient,
  CreateUserCommand,
  DeleteUserCommand,
  DescribeUserCommand,
  GetUserIdCommand,
  ListUsersCommand,
  CreateGroupCommand,
  DeleteGroupCommand,
  GetGroupIdCommand,
  ListGroupsCommand,
  CreateGroupMembershipCommand,
  DeleteGroupMembershipCommand,
  ListGroupMembershipsCommand,
  ListGroupMembershipsForMemberCommand,
} from '@aws-sdk/client-identitystore';
import config from '../config/config';
import logger from '../utils/logger';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  ExternalServiceError,
} from '../utils/errors';

/**
 * Low-level client for AWS IAM Identity Center's **Identity Store** API.
 *
 * This is the AWS analogue of {@link ../services/redash.service redash.service}:
 * it owns every SDK call and the simulation branches, so the adapter
 * ({@link ./aws.provisioner}) stays a thin, platform-agnostic translation layer.
 *
 * Why Identity Center (vs classic IAM users): the access being granted here is for
 * **humans**. Identity Center gives central MFA, SSO sign-in, short-lived creds,
 * and an onboarding email handled by AWS — and its membership APIs
 * (Create/DeleteGroupMembership) are fully writable by an automation principal, so
 * Hermes still owns membership the way the adapter contract assumes.
 *
 * Identifier model (collision-safe by construction):
 *  - We store AWS's **immutable, server-assigned `UserId`** (a GUID) as the user's
 *    `externalUserId`. We never derive an id from the email, so two similar emails
 *    can't collide onto one principal.
 *  - The Identity Store `UserName` is set to the (lower-cased) email, which the
 *    Identity Store enforces as unique. Lookups go through `GetUserId` by that
 *    UserName, so on a "already exists" race we re-resolve the *same* email — there
 *    is no blind id reuse.
 *  - `externalGroupId` is the Identity Store **GroupId** (a GUID).
 *
 * Access itself (what a group actually lets a user do) comes from an Identity
 * Center **account assignment** (group → permission set → account) that an admin
 * configures once per group in the console — the same mental model as configuring a
 * Redash group's data-source permissions. Hermes only manages membership.
 */

export interface IdcUser {
  userId: string;
  userName: string;
  displayName: string;
  email: string;
  /** Identity Store has no "invitation pending" flag the way Redash does. */
  isPending: boolean;
  /** GroupIds this user is a member of (filled by listUsers / membership reads). */
  groupIds: string[];
}

export interface IdcGroup {
  groupId: string;
  displayName: string;
  description?: string;
}

// ── Simulation store ────────────────────────────────────────────────────────
// In-process, stateful mock so the full grant/revoke/expire flow is coherent
// within a running backend (create user → create group → add member → check →
// remove all agree). Resets on restart, exactly like Redash's mock — fine for
// local dev. Seeded with the same people the Redash sim uses.

interface SimUser {
  userId: string;
  userName: string;
  displayName: string;
  email: string;
}
interface SimGroup {
  groupId: string;
  displayName: string;
  description?: string;
}

const sim = {
  seeded: false,
  users: new Map<string, SimUser>(), // userId -> user
  groups: new Map<string, SimGroup>(), // groupId -> group
  memberships: new Map<string, { groupId: string; userId: string }>(), // membershipId -> edge
};

function simMembershipKey(groupId: string, userId: string): string {
  return `mem-${groupId}-${userId}`;
}

function ensureSimSeeded(): void {
  if (sim.seeded) return;
  sim.seeded = true;
  const seedUsers: Array<Omit<SimUser, 'userId'> & { userId: string }> = [
    { userId: 'usr-sim-mayank', userName: 'mayank.aggarwal@bachatt.app', displayName: 'Mayank Aggarwal', email: 'mayank.aggarwal@bachatt.app' },
    { userId: 'usr-sim-yogesh', userName: 'yogesh.verma@bachatt.app', displayName: 'Yogesh Verma', email: 'yogesh.verma@bachatt.app' },
    { userId: 'usr-sim-rishit', userName: 'rishit.goel@bachatt.app', displayName: 'Rishit Goel', email: 'rishit.goel@bachatt.app' },
    { userId: 'usr-sim-ankit', userName: 'ankit.sharma@bachatt.app', displayName: 'Ankit Sharma', email: 'ankit.sharma@bachatt.app' },
  ];
  for (const u of seedUsers) sim.users.set(u.userId, u);
  const seedGroups: SimGroup[] = [
    { groupId: 'grp-sim-growth', displayName: 'Growth', description: 'AWS Growth team' },
    { groupId: 'grp-sim-credit-card', displayName: 'Credit Card', description: 'AWS Credit Card team' },
  ];
  for (const g of seedGroups) sim.groups.set(g.groupId, g);
}

function randomSimId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── AWS SDK error names we special-case ──────────────────────────────────────
const ERR_CONFLICT = 'ConflictException';
const ERR_NOT_FOUND = 'ResourceNotFoundException';
const ERR_VALIDATION = 'ValidationException';

/** True if this error is a transient/retryable AWS condition. */
function isRetryable(err: any): boolean {
  const name = err?.name;
  if (
    name === 'ThrottlingException' ||
    name === 'InternalServerException' ||
    name === 'TooManyRequestsException'
  ) {
    return true;
  }
  // AWS SDK v3 attaches `$retryable` as an object on retryable errors; only the
  // `throttling: true` shape is a genuine transient. The previous `!== undefined`
  // check treated permanent errors that merely carry the annotation (e.g. some
  // AccessDenied / quota cases) as retryable, burning the whole backoff budget and
  // logging them as "transient" — masking the real cause.
  return err?.$retryable?.throttling === true;
}

export class AwsIdentityCenterService {
  private client: IdentitystoreClient | null = null;

  private get isSimulation(): boolean {
    return config.aws.isSimulation;
  }

  private get identityStoreId(): string {
    const id = config.aws.identityStoreId;
    if (!id) {
      // Should be unreachable: isSimulation is true whenever this is unset, so a
      // live path never gets here without an id. Guard anyway.
      throw new ExternalServiceError('AWS_IDENTITY_STORE_ID is not configured');
    }
    return id;
  }

  /** Lazily build a single Identity Store client (reused for retry-token quota). */
  private getClient(): IdentitystoreClient {
    if (this.client) return this.client;
    const region = config.aws.identityCenterRegion;
    if (!region) {
      throw new ExternalServiceError('AWS region for Identity Center is not configured');
    }
    const accessKeyId = config.aws.accessKeyId;
    const secretAccessKey = config.aws.secretAccessKey;
    this.client = new IdentitystoreClient({
      region,
      // List-heavy + bursty (sync) → ride out IAM/Identity Store throttling with
      // adaptive client-side rate limiting and more attempts before surfacing.
      maxAttempts: 6,
      retryMode: 'adaptive',
      // Prefer the default credential chain (task role / IRSA in prod). Only pass
      // static keys when explicitly provided for an out-of-AWS deployment — and
      // those must be the dedicated hermes-provisioner user, never root.
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });
    return this.client;
  }

  /**
   * Run an AWS read that may briefly 404 right after a create (Identity Store is
   * eventually consistent). Retries ONLY on ResourceNotFound / retryable errors,
   * with exponential backoff (~0.3s, 0.6s, 1.2s, 2.4s → ~4.5s total). Any other
   * error propagates immediately.
   */
  private async withConsistencyRetry<T>(
    op: string,
    fn: () => Promise<T>,
    attempts = 4,
  ): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;
        if (err?.name !== ERR_NOT_FOUND && !isRetryable(err)) throw err;
        if (i < attempts - 1) {
          const delayMs = 300 * Math.pow(2, i);
          logger.warn(
            { op, attempt: i + 1, errName: err?.name, delayMs },
            'AWS Identity Center: transient error, retrying (eventual consistency)',
          );
          await new Promise(res => setTimeout(res, delayMs));
        }
      }
    }
    throw lastErr;
  }

  /** Map an unhandled AWS SDK error to a Hermes BaseError (by name, not status). */
  private mapError(err: any, op: string): never {
    const name: string | undefined = err?.name;
    const msg = err?.message || String(err);
    const ctx = { op, awsErrorName: name };
    switch (name) {
      case ERR_CONFLICT:
        throw new ConflictError(`AWS Identity Center conflict during ${op}: ${msg}`, ctx);
      case ERR_NOT_FOUND:
        throw new NotFoundError(`AWS Identity Center entity not found during ${op}: ${msg}`, ctx);
      case ERR_VALIDATION:
        throw new ValidationError(`AWS Identity Center rejected ${op}: ${msg}`, ctx);
      default:
        throw new ExternalServiceError(`AWS Identity Center error during ${op}: ${msg}`, ctx);
    }
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  /** Resolve a user's immutable UserId by email (their UserName). Null if absent. */
  async getUserIdByEmail(email: string): Promise<string | null> {
    const userName = email.toLowerCase();
    if (this.isSimulation) {
      ensureSimSeeded();
      const found = [...sim.users.values()].find(u => u.userName === userName);
      return found ? found.userId : null;
    }
    try {
      const res = await this.getClient().send(
        new GetUserIdCommand({
          IdentityStoreId: this.identityStoreId,
          AlternateIdentifier: {
            UniqueAttribute: { AttributePath: 'userName', AttributeValue: userName },
          },
        }),
      );
      return res.UserId ?? null;
    } catch (err: any) {
      if (err?.name === ERR_NOT_FOUND) return null; // normal "absent" signal, not a 500
      this.mapError(err, 'getUserIdByEmail');
    }
  }

  /** Describe a user by id. Null if it no longer exists. */
  async getUserById(userId: string): Promise<IdcUser | null> {
    if (this.isSimulation) {
      ensureSimSeeded();
      const u = sim.users.get(userId);
      if (!u) return null;
      const groupIds = [...sim.memberships.values()].filter(m => m.userId === userId).map(m => m.groupId);
      return { userId: u.userId, userName: u.userName, displayName: u.displayName, email: u.email, isPending: false, groupIds };
    }
    try {
      const res = await this.getClient().send(
        new DescribeUserCommand({ IdentityStoreId: this.identityStoreId, UserId: userId }),
      );
      const email = res.Emails?.find(e => e.Primary)?.Value || res.Emails?.[0]?.Value || res.UserName || '';
      return {
        userId: res.UserId!,
        userName: res.UserName || email,
        displayName: res.DisplayName || res.UserName || email,
        email: email.toLowerCase(),
        isPending: false,
        groupIds: await this.listGroupIdsForUser(userId),
      };
    } catch (err: any) {
      if (err?.name === ERR_NOT_FOUND) return null;
      this.mapError(err, 'getUserById');
    }
  }

  /**
   * Create a user, or return the existing one's id if the email is already taken.
   * Idempotent: an `EntityAlreadyExists`-style conflict resolves the SAME email
   * back to its id (no blind reuse). The recovery read is consistency-retried
   * because CreateUser→GetUserId is the most eventual-consistency-exposed path.
   */
  async createUser(email: string, name: string): Promise<{ userId: string }> {
    const userName = email.toLowerCase();
    if (this.isSimulation) {
      ensureSimSeeded();
      const existing = [...sim.users.values()].find(u => u.userName === userName);
      if (existing) return { userId: existing.userId };
      const userId = randomSimId('usr-sim');
      sim.users.set(userId, { userId, userName, displayName: name, email: userName });
      logger.info({ userId, email: userName }, '🧪 AWS IDC (sim): created user');
      return { userId };
    }
    const { given, family } = splitName(name);
    try {
      const res = await this.getClient().send(
        new CreateUserCommand({
          IdentityStoreId: this.identityStoreId,
          UserName: userName,
          DisplayName: name,
          Name: { GivenName: given, FamilyName: family },
          Emails: [{ Value: userName, Type: 'work', Primary: true }],
        }),
      );
      return { userId: res.UserId! };
    } catch (err: any) {
      if (err?.name === ERR_CONFLICT) {
        // Someone (or a sync) created it concurrently — resolve the same email.
        const existingId = await this.withConsistencyRetry('createUser:recover', async () => {
          const id = await this.getUserIdByEmail(userName);
          if (!id) {
            const e: any = new Error('user reported existing but not yet resolvable');
            e.name = ERR_NOT_FOUND;
            throw e;
          }
          return id;
        });
        return { userId: existingId };
      }
      this.mapError(err, 'createUser');
    }
  }

  /**
   * PERMANENTLY delete a user from Identity Center (offboarding — not group
   * membership, which is add/removeUserFromGroup). Identity Store has no
   * "disabled" flag on a user, so this is the only account-level action available;
   * it is irreversible — recreating the person later makes a brand-new user with a
   * new UserId, and any historical linkage by that id is gone. Clears group
   * memberships first (defensive, mirrors deleteGroup's own cleanup) then deletes
   * the user. Tolerates an already-absent user so it's safe to call twice.
   */
  async deleteUser(userId: string): Promise<void> {
    if (this.isSimulation) {
      ensureSimSeeded();
      for (const [key, m] of sim.memberships) {
        if (m.userId === userId) sim.memberships.delete(key);
      }
      sim.users.delete(userId);
      logger.info({ userId }, '🧪 AWS IDC (sim): deleted user');
      return;
    }
    try {
      let nextToken: string | undefined;
      do {
        const res = await this.getClient().send(
          new ListGroupMembershipsForMemberCommand({
            IdentityStoreId: this.identityStoreId,
            MemberId: { UserId: userId },
            MaxResults: 100,
            NextToken: nextToken,
          }),
        );
        for (const m of res.GroupMemberships ?? []) {
          if (m.MembershipId) {
            await this.getClient().send(
              new DeleteGroupMembershipCommand({
                IdentityStoreId: this.identityStoreId,
                MembershipId: m.MembershipId,
              }),
            );
          }
        }
        nextToken = res.NextToken;
      } while (nextToken);

      await this.getClient().send(
        new DeleteUserCommand({ IdentityStoreId: this.identityStoreId, UserId: userId }),
      );
    } catch (err: any) {
      if (err?.name === ERR_NOT_FOUND) {
        logger.info({ userId }, 'AWS Identity Center: user already absent; nothing to delete');
        return;
      }
      this.mapError(err, 'deleteUser');
    }
  }

  /** List every Identity Store user (paginated) with their group memberships. */
  async listUsers(): Promise<IdcUser[]> {
    if (this.isSimulation) {
      ensureSimSeeded();
      return [...sim.users.values()].map(u => ({
        userId: u.userId,
        userName: u.userName,
        displayName: u.displayName,
        email: u.email,
        isPending: false,
        groupIds: [...sim.memberships.values()].filter(m => m.userId === u.userId).map(m => m.groupId),
      }));
    }
    try {
      const users: IdcUser[] = [];
      let nextToken: string | undefined;
      do {
        const res = await this.getClient().send(
          new ListUsersCommand({ IdentityStoreId: this.identityStoreId, MaxResults: 100, NextToken: nextToken }),
        );
        for (const u of res.Users ?? []) {
          const email = u.Emails?.find(e => e.Primary)?.Value || u.Emails?.[0]?.Value || u.UserName || '';
          users.push({
            userId: u.UserId!,
            userName: u.UserName || email,
            displayName: u.DisplayName || u.UserName || email,
            email: email.toLowerCase(),
            isPending: false,
            groupIds: [], // filled below in one pass per user
          });
        }
        nextToken = res.NextToken;
      } while (nextToken);
      // Resolve memberships by listing each GROUP's members once (O(groups) calls)
      // instead of each user's groups (O(users) calls). Groups are far fewer than
      // users, so this avoids an N+1 across the whole directory on every sync.
      const membershipMap = await this.buildUserGroupMap();
      for (const u of users) {
        u.groupIds = membershipMap.get(u.userId) ?? [];
      }
      return users;
    } catch (err: any) {
      this.mapError(err, 'listUsers');
    }
  }

  /**
   * Build a userId → groupIds map by listing memberships per GROUP (O(groups) API
   * calls) rather than per user (O(users)). Used by listUsers so a full directory
   * sync doesn't fan out one membership call per user.
   */
  private async buildUserGroupMap(): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    const groups = await this.listGroups();
    for (const g of groups) {
      let nextToken: string | undefined;
      do {
        const res = await this.getClient().send(
          new ListGroupMembershipsCommand({
            IdentityStoreId: this.identityStoreId,
            GroupId: g.groupId,
            MaxResults: 100,
            NextToken: nextToken,
          }),
        );
        for (const m of res.GroupMemberships ?? []) {
          const uid = (m.MemberId as { UserId?: string } | undefined)?.UserId;
          if (uid) {
            const existing = map.get(uid);
            if (existing) existing.push(g.groupId);
            else map.set(uid, [g.groupId]);
          }
        }
        nextToken = res.NextToken;
      } while (nextToken);
    }
    return map;
  }

  // ── Groups ───────────────────────────────────────────────────────────────

  /** Resolve a group's id by its display name. Null if absent. */
  async getGroupIdByName(displayName: string): Promise<string | null> {
    if (this.isSimulation) {
      ensureSimSeeded();
      const found = [...sim.groups.values()].find(g => g.displayName === displayName);
      return found ? found.groupId : null;
    }
    try {
      const res = await this.getClient().send(
        new GetGroupIdCommand({
          IdentityStoreId: this.identityStoreId,
          AlternateIdentifier: {
            UniqueAttribute: { AttributePath: 'displayName', AttributeValue: displayName },
          },
        }),
      );
      return res.GroupId ?? null;
    } catch (err: any) {
      if (err?.name === ERR_NOT_FOUND) return null;
      this.mapError(err, 'getGroupIdByName');
    }
  }

  /** Create a backing group, or reuse the existing one with the same name. */
  async createGroup(displayName: string, description?: string): Promise<IdcGroup> {
    if (this.isSimulation) {
      ensureSimSeeded();
      const existing = [...sim.groups.values()].find(g => g.displayName === displayName);
      if (existing) return existing;
      const groupId = randomSimId('grp-sim');
      const group: SimGroup = { groupId, displayName, description };
      sim.groups.set(groupId, group);
      logger.info({ groupId, displayName }, '🧪 AWS IDC (sim): created group');
      return group;
    }
    try {
      const res = await this.getClient().send(
        new CreateGroupCommand({
          IdentityStoreId: this.identityStoreId,
          DisplayName: displayName,
          Description: description,
        }),
      );
      return { groupId: res.GroupId!, displayName, description };
    } catch (err: any) {
      if (err?.name === ERR_CONFLICT) {
        const existingId = await this.withConsistencyRetry('createGroup:recover', async () => {
          const id = await this.getGroupIdByName(displayName);
          if (!id) {
            const e: any = new Error('group reported existing but not yet resolvable');
            e.name = ERR_NOT_FOUND;
            throw e;
          }
          return id;
        });
        return { groupId: existingId, displayName, description };
      }
      this.mapError(err, 'createGroup');
    }
  }

  /**
   * Delete a group after clearing its memberships (Identity Store won't delete a
   * non-empty group cleanly). Tolerates an already-deleted group as success — but
   * a just-created group that 404s is retried first (eventual consistency), so a
   * rollback of a fresh group doesn't silently orphan it.
   */
  async deleteGroup(groupId: string): Promise<void> {
    if (this.isSimulation) {
      ensureSimSeeded();
      for (const [key, m] of sim.memberships) {
        if (m.groupId === groupId) sim.memberships.delete(key);
      }
      sim.groups.delete(groupId);
      logger.info({ groupId }, '🧪 AWS IDC (sim): deleted group');
      return;
    }
    try {
      // Clear members first.
      let nextToken: string | undefined;
      do {
        const res = await this.getClient().send(
          new ListGroupMembershipsCommand({
            IdentityStoreId: this.identityStoreId,
            GroupId: groupId,
            MaxResults: 100,
            NextToken: nextToken,
          }),
        );
        for (const m of res.GroupMemberships ?? []) {
          if (m.MembershipId) {
            await this.getClient().send(
              new DeleteGroupMembershipCommand({
                IdentityStoreId: this.identityStoreId,
                MembershipId: m.MembershipId,
              }),
            );
          }
        }
        nextToken = res.NextToken;
      } while (nextToken);

      await this.getClient().send(
        new DeleteGroupCommand({ IdentityStoreId: this.identityStoreId, GroupId: groupId }),
      );
    } catch (err: any) {
      if (err?.name === ERR_NOT_FOUND) {
        logger.info({ groupId }, 'AWS Identity Center: group already absent; nothing to delete');
        return;
      }
      this.mapError(err, 'deleteGroup');
    }
  }

  /** List every Identity Store group (paginated). */
  async listGroups(): Promise<IdcGroup[]> {
    if (this.isSimulation) {
      ensureSimSeeded();
      return [...sim.groups.values()].map(g => ({ ...g }));
    }
    try {
      const groups: IdcGroup[] = [];
      let nextToken: string | undefined;
      do {
        const res = await this.getClient().send(
          new ListGroupsCommand({ IdentityStoreId: this.identityStoreId, MaxResults: 100, NextToken: nextToken }),
        );
        for (const g of res.Groups ?? []) {
          groups.push({ groupId: g.GroupId!, displayName: g.DisplayName || g.GroupId!, description: g.Description });
        }
        nextToken = res.NextToken;
      } while (nextToken);
      return groups;
    } catch (err: any) {
      this.mapError(err, 'listGroups');
    }
  }

  // ── Memberships ────────────────────────────────────────────────────────────

  /** Add a user to a group. Idempotent (a conflict = already a member = success). */
  async addUserToGroup(groupId: string, userId: string): Promise<void> {
    if (this.isSimulation) {
      ensureSimSeeded();
      const key = simMembershipKey(groupId, userId);
      sim.memberships.set(key, { groupId, userId });
      logger.info({ groupId, userId }, '🧪 AWS IDC (sim): added member');
      return;
    }
    try {
      // The user/group may have been created moments ago → ride out the
      // eventual-consistency window before declaring a real not-found.
      await this.withConsistencyRetry('addUserToGroup', () =>
        this.getClient().send(
          new CreateGroupMembershipCommand({
            IdentityStoreId: this.identityStoreId,
            GroupId: groupId,
            MemberId: { UserId: userId },
          }),
        ),
      );
    } catch (err: any) {
      if (err?.name === ERR_CONFLICT) {
        logger.info({ groupId, userId }, 'AWS Identity Center: user already a member');
        return;
      }
      this.mapError(err, 'addUserToGroup');
    }
  }

  /**
   * Remove a user from a group. Idempotent: a genuine "not a member" is success.
   * We resolve the membership id with a read first, so a transient not-found can't
   * be mistaken for "already removed" (which during a level-swap would silently
   * leave the user in two groups).
   */
  async removeUserFromGroup(groupId: string, userId: string): Promise<void> {
    if (this.isSimulation) {
      ensureSimSeeded();
      sim.memberships.delete(simMembershipKey(groupId, userId));
      logger.info({ groupId, userId }, '🧪 AWS IDC (sim): removed member');
      return;
    }
    try {
      // Resolve the MembershipId via ListGroupMembershipsForMember rather than
      // GetGroupMembershipId: live testing showed GetGroupMembershipId can return
      // ResourceNotFound for a membership that demonstrably exists (its lookup index
      // lags), which would make a revoke silently no-op while the user stays in the
      // group. The list path returns the id directly and is consistent with our
      // other membership reads. Bounded retry rides out the post-create window.
      // 6 attempts (~9s) — Identity Store membership reads can lag several seconds
      // behind a just-created membership, longer than the default window. Real
      // revokes act on long-existing (consistent) memberships and resolve first try;
      // the wider budget only matters for a rapid grant→revoke.
      const membershipId = await this.withConsistencyRetry('removeUserFromGroup:lookup', async () => {
        const id = await this.findMembershipId(groupId, userId);
        if (!id) {
          const e: any = new Error('membership not yet resolvable');
          e.name = ERR_NOT_FOUND;
          throw e;
        }
        return id;
      }, 6);
      await this.getClient().send(
        new DeleteGroupMembershipCommand({
          IdentityStoreId: this.identityStoreId,
          MembershipId: membershipId,
        }),
      );
    } catch (err: any) {
      if (err?.name === ERR_NOT_FOUND) {
        // After the bounded retry above, a genuine not-found: the membership is gone
        // (or the user/group was deleted). Idempotent — treat as removed.
        logger.info({ groupId, userId }, 'AWS Identity Center: membership already absent');
        return;
      }
      this.mapError(err, 'removeUserFromGroup');
    }
  }

  /** Find the MembershipId for (group, user) by listing the member's memberships. */
  private async findMembershipId(groupId: string, userId: string): Promise<string | undefined> {
    let nextToken: string | undefined;
    do {
      const res = await this.getClient().send(
        new ListGroupMembershipsForMemberCommand({
          IdentityStoreId: this.identityStoreId,
          MemberId: { UserId: userId },
          MaxResults: 100,
          NextToken: nextToken,
        }),
      );
      for (const m of res.GroupMemberships ?? []) {
        if (m.GroupId === groupId && m.MembershipId) return m.MembershipId;
      }
      nextToken = res.NextToken;
    } while (nextToken);
    return undefined;
  }

  /** GroupIds a user belongs to (paginated). */
  async listGroupIdsForUser(userId: string): Promise<string[]> {
    if (this.isSimulation) {
      ensureSimSeeded();
      return [...sim.memberships.values()].filter(m => m.userId === userId).map(m => m.groupId);
    }
    try {
      const ids: string[] = [];
      let nextToken: string | undefined;
      do {
        const res = await this.getClient().send(
          new ListGroupMembershipsForMemberCommand({
            IdentityStoreId: this.identityStoreId,
            MemberId: { UserId: userId },
            MaxResults: 100,
            NextToken: nextToken,
          }),
        );
        for (const m of res.GroupMemberships ?? []) {
          if (m.GroupId) ids.push(m.GroupId);
        }
        nextToken = res.NextToken;
      } while (nextToken);
      return ids;
    } catch (err: any) {
      if (err?.name === ERR_NOT_FOUND) return [];
      this.mapError(err, 'listGroupIdsForUser');
    }
  }

  // ── Health ──────────────────────────────────────────────────────────────────

  /** Cheap liveness probe: list a single group. Never throws. */
  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (this.isSimulation) return { healthy: true, message: 'simulation' };
    try {
      await this.getClient().send(
        new ListGroupsCommand({ IdentityStoreId: this.identityStoreId, MaxResults: 1 }),
      );
      return { healthy: true };
    } catch (err: any) {
      return { healthy: false, message: err?.message || String(err) };
    }
  }
}

/** Split a display name into given/family for the Identity Store Name field. */
function splitName(name: string): { given: string; family: string } {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { given: 'Unknown', family: 'User' };
  if (parts.length === 1) return { given: parts[0], family: parts[0] };
  return { given: parts[0], family: parts.slice(1).join(' ') };
}

export const awsIdentityCenterService = new AwsIdentityCenterService();
export default awsIdentityCenterService;
