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
 * True if the user can administer the given platform: super admin, or a
 * PlatformAdmin mirror row exists for (user, platform).
 */
export async function isPlatformAdminOf(
  user: AuthenticatedUser,
  platform: string,
): Promise<boolean> {
  if (isSuperAdmin(user)) return true;

  const p = platform.toLowerCase();
  const row = await prisma.platformAdmin.findUnique({
    where: { userId_platform: { userId: user.id, platform: p } },
  });
  return !!row;
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
  groupSlug?: string | null,
): Promise<boolean> {
  if (isSuperAdmin(user)) return true;

  // Direct DB group-admin row.
  const dbAdmin = await prisma.groupAdmin.findUnique({
    where: { groupId_userId: { groupId, userId: user.id } },
  });
  if (dbAdmin) return true;

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
  const [pa, ga] = await Promise.all([
    prisma.platformAdmin.findFirst({ where: { userId: user.id }, select: { id: true } }),
    prisma.groupAdmin.findFirst({ where: { userId: user.id }, select: { id: true } }),
  ]);
  return !!pa || !!ga;
}

/**
 * Platform keys the user may manage. Super admins manage every registered
 * platform; everyone else gets their PlatformAdmin mirror rows. Lower-cased + de-duped.
 */
export async function getManageablePlatforms(user: AuthenticatedUser): Promise<string[]> {
  if (isSuperAdmin(user)) {
    return provisioningRegistry.listPlatforms();
  }

  const rows = await prisma.platformAdmin.findMany({
    where: { userId: user.id },
    select: { platform: true },
  });
  return Array.from(new Set(rows.map((r) => r.platform.toLowerCase())));
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
