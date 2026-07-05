import prisma from '../config/prisma';
import provisioningRegistry from '../services/provisioning.registry';
import { AuthenticatedUser } from '../middleware/auth.middleware';

const SUPER_ADMIN_ROLE = 'hermes_super_admin';

/**
 * Admin tiers, highest to lowest:
 *   - hermes_super_admin  → everything, all platforms (Keycloak realm role; the
 *                           one tier that stays Keycloak-authoritative — it's
 *                           assigned manually in Keycloak and has no DB mirror).
 *   - platform_admin      → all groups on one platform (PlatformAdmin mirror row).
 *   - group_admin         → one group (GroupAdmin mirror row).
 *
 * Authorization for the two scoped tiers is **mirror-authoritative**: a user is a
 * platform/group admin iff a PlatformAdmin/GroupAdmin row exists for them. Every
 * assignment writes that row synchronously (admin-management.controller) and the
 * reconciliation job repairs Keycloak→DB drift, so:
 *   - grants take effect immediately (the row is written before the JWT refreshes), and
 *   - removals take effect immediately (deleting the row denies the next request,
 *     even though the just-removed scoped role still lingers in an already-issued JWT
 *     until it expires).
 * Tradeoff: a scoped role assigned *directly in Keycloak* (bypassing Hermes) is not
 * authorized until reconciliation adds its mirror row. The JWT scoped-role strings are
 * no longer consulted here (see auth.middleware's parse helpers — kept for back-compat
 * and the cosmetic group-list badge only).
 */

export const isSuperAdmin = (user: AuthenticatedUser): boolean =>
  user.roles.includes(SUPER_ADMIN_ROLE);

/**
 * Per-request memo of the user's mirror rows. Keyed on the request's user OBJECT
 * (a fresh object is built per request in auth.middleware, both live and
 * simulated), so the cache lives exactly as long as one request: handlers that
 * call several authz helpers (isAnyAdmin → isPlatformAdminOf → ...) share two
 * queries instead of issuing one per check. Safe because every handler
 * authorizes BEFORE mutating admin rows — within a single request the snapshot
 * never needs to observe its own writes.
 */
interface AuthzSnapshot {
  /** Lower-cased platform keys from the user's PlatformAdmin rows. */
  platformAdminPlatforms: Promise<Set<string>>;
  /** groupIds from the user's GroupAdmin rows. */
  groupAdminGroupIds: Promise<Set<string>>;
}

const snapshotCache = new WeakMap<AuthenticatedUser, AuthzSnapshot>();

function getSnapshot(user: AuthenticatedUser): AuthzSnapshot {
  let snap = snapshotCache.get(user);
  if (!snap) {
    snap = {
      platformAdminPlatforms: prisma.platformAdmin
        .findMany({ where: { userId: user.id }, select: { platform: true } })
        .then((rows) => new Set(rows.map((r) => r.platform.toLowerCase()))),
      groupAdminGroupIds: prisma.groupAdmin
        .findMany({ where: { userId: user.id }, select: { groupId: true } })
        .then((rows) => new Set(rows.map((r) => r.groupId))),
    };
    snapshotCache.set(user, snap);
  }
  return snap;
}

/**
 * True if the user can administer the given platform: super admin, or a
 * PlatformAdmin mirror row exists for (user, platform).
 */
export async function isPlatformAdminOf(
  user: AuthenticatedUser,
  platform: string,
): Promise<boolean> {
  if (isSuperAdmin(user)) return true;
  const platforms = await getSnapshot(user).platformAdminPlatforms;
  return platforms.has(platform.toLowerCase());
}

/**
 * True if the user can administer the given group: super admin, a GroupAdmin
 * mirror row for this group, or platform admin of the group's platform.
 *
 * `groupSlug` is accepted for call-site compatibility; it is no longer needed
 * (authorization is mirror-based, not slug/role parsing).
 */
export async function isGroupAdminOf(
  user: AuthenticatedUser,
  groupId: string,
  _groupSlug?: string | null,
): Promise<boolean> {
  if (isSuperAdmin(user)) return true;

  // Direct group-admin assignment.
  const groupIds = await getSnapshot(user).groupAdminGroupIds;
  if (groupIds.has(groupId)) return true;

  // Platform admin of the group's platform manages all its groups.
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: { platform: true },
  });
  if (group?.platform && (await isPlatformAdminOf(user, group.platform))) return true;

  return false;
}

/**
 * Coarse "is this user any kind of admin" check (super, any platform admin, or any
 * group admin). Used as an authorization precheck before a resource lookup so a
 * non-admin gets a uniform 403 instead of a 404-vs-403 existence oracle.
 */
export async function isAnyAdmin(user: AuthenticatedUser): Promise<boolean> {
  if (isSuperAdmin(user)) return true;
  const snap = getSnapshot(user);
  const [platforms, groupIds] = await Promise.all([
    snap.platformAdminPlatforms,
    snap.groupAdminGroupIds,
  ]);
  return platforms.size > 0 || groupIds.size > 0;
}

/**
 * Platform keys the user may manage. Super admins manage every registered
 * platform; everyone else gets their PlatformAdmin mirror rows. Lower-cased + de-duped.
 */
export async function getManageablePlatforms(user: AuthenticatedUser): Promise<string[]> {
  const platforms = isSuperAdmin(user)
    ? provisioningRegistry.listPlatforms()
    : Array.from(await getSnapshot(user).platformAdminPlatforms);
  // Honor each adapter's own enabled/disabled state (optional isEnabled() hook —
  // today only AWS implements it). Adapters without it (Redash, ZooKeeper) are
  // always treated as enabled.
  return platforms.filter((key) => {
    const adapter = provisioningRegistry.tryGet(key);
    return !(adapter?.isEnabled && !adapter.isEnabled());
  });
}

export interface AdminScopes {
  superAdmin: boolean;
  /** Platform keys the user can administer (all registered, if super admin). */
  platforms: string[];
  /** Group slugs the user can administer directly. Empty for super admin (they
   *  implicitly manage all groups — the frontend treats superAdmin specially). */
  groups: string[];
}

/**
 * Group slugs for direct GroupAdmin assignments only. Platform admins can manage
 * all groups on their platform, but they should not be physically enrolled into
 * every external platform group.
 */
export async function getDirectGroupAdminSlugs(user: AuthenticatedUser): Promise<string[]> {
  if (isSuperAdmin(user)) return [];

  const dbGroups = await prisma.groupAdmin.findMany({
    where: { userId: user.id },
    select: { group: { select: { slug: true } } },
  });
  return Array.from(new Set(dbGroups.map((g) => g.group.slug)));
}

/**
 * Group ids the user can manage/review on a given platform: `all: true` (no
 * need to enumerate) for a super admin or platform admin of that platform,
 * otherwise just their direct GroupAdmin assignments scoped to that platform.
 * The single home for "which groups can this user act on for platform X" —
 * callers with a per-request workflow (e.g. Secret Ingestion review) should use
 * this instead of re-deriving admin status inline.
 */
export async function getManageableGroupIds(
  user: AuthenticatedUser,
  platform: string,
): Promise<{ all: boolean; groupIds: string[] }> {
  if (isSuperAdmin(user) || (await isPlatformAdminOf(user, platform))) {
    return { all: true, groupIds: [] };
  }
  const rows = await prisma.groupAdmin.findMany({
    where: { userId: user.id },
    include: { group: { select: { platform: true } } },
  });
  return {
    all: false,
    groupIds: rows.filter((r) => r.group.platform === platform).map((r) => r.groupId),
  };
}

/**
 * Resolve the user's admin scopes for the frontend (nav gating + UI scoping) and
 * for server-side request scoping (e.g. pending-approvals). Returned on /auth/me.
 * Derived from the DB mirrors (mirror-authoritative model).
 */
export async function computeAdminScopes(user: AuthenticatedUser): Promise<AdminScopes> {
  const superAdmin = isSuperAdmin(user);
  const platforms = await getManageablePlatforms(user);

  if (superAdmin) {
    return { superAdmin, platforms, groups: [] };
  }

  // Group slugs from the GroupAdmin mirror + every group on a platform the user
  // administers (platform admins manage all groups on their platform). Do not use
  // this expanded set for platform membership provisioning.
  const dbSlugs = await getDirectGroupAdminSlugs(user);

  let platformGroupSlugs: string[] = [];
  if (platforms.length > 0) {
    const groups = await prisma.group.findMany({
      where: { platform: { in: platforms } },
      select: { slug: true },
    });
    platformGroupSlugs = groups.map((g) => g.slug);
  }

  const groups = Array.from(new Set([...dbSlugs, ...platformGroupSlugs]));
  return { superAdmin, platforms, groups };
}
