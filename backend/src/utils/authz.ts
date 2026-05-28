import prisma from '../config/prisma';
import { AuthenticatedUser, checkIsGroupAdmin } from '../middleware/auth.middleware';

const SUPER_ADMIN_ROLE = 'atlas_super_admin';
const GROUP_ADMIN_ROLE = 'atlas_group_admin';

export const isSuperAdmin = (user: AuthenticatedUser): boolean =>
  user.roles.includes(SUPER_ADMIN_ROLE);

/**
 * True if the user can administer the given group:
 *   - super admin, OR
 *   - has `atlas_group_admin` AND (a GroupAdmin DB row OR a matching Keycloak
 *     `atlas_group_admin_<slug>` role for that group's slug).
 *
 * Accepts an optional preloaded group slug to avoid a redundant DB lookup
 * when the caller already has the group in hand.
 */
export async function isGroupAdminOf(
  user: AuthenticatedUser,
  groupId: string,
  groupSlug?: string | null,
): Promise<boolean> {
  if (isSuperAdmin(user)) return true;
  if (!user.roles.includes(GROUP_ADMIN_ROLE)) return false;

  const dbAdmin = await prisma.groupAdmin.findUnique({
    where: { groupId_userId: { groupId, userId: user.id } },
  });
  if (dbAdmin) return true;

  let slug = groupSlug ?? null;
  if (slug === undefined || slug === null) {
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      select: { slug: true },
    });
    slug = group?.slug ?? null;
  }

  return !!slug && checkIsGroupAdmin(user.roles, slug);
}
