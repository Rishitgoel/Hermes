/**
 * Mirror a platform's automatic built-in "default" group membership into Hermes.
 *
 * On Redash every new user is automatically a member of the built-in `default`
 * group. To keep the Hermes view uniform with that reality — and consistent with
 * the membership import, which backfills the same grant for existing users — we
 * record a permanent grant to the Hermes group backing the platform's built-in
 * `default` group whenever an account is created (see the user-creation.completed
 * listener in event-listeners.ts).
 *
 * Self-limiting and safe:
 *  - No-op for platforms without a built-in `default` group (e.g. AWS) — the lookup
 *    simply finds nothing.
 *  - No-op if that group isn't modeled in Hermes yet.
 *  - Idempotent: an existing active grant is left untouched.
 */
import prisma from '../config/prisma';
import logger from '../utils/logger';

export async function ensureDefaultGroupMembership(
  platform: string,
  user: { userId: string; userName: string; userEmail: string; externalUserId?: string | null },
): Promise<void> {
  // Identify the built-in "default" group from the synced cache (name "default",
  // type "builtin") rather than a hardcoded id — the id varies per Redash instance.
  const ext = await prisma.platformExternalGroup.findFirst({
    where: { platform, type: 'builtin', name: { equals: 'default', mode: 'insensitive' } },
    select: { externalId: true },
  });
  if (!ext) {
    return; // platform has no built-in default group (or its cache isn't populated)
  }

  // The Hermes group backing it — may be archived; we still mirror the membership.
  const group = await prisma.group.findFirst({
    where: { platform, externalGroupId: ext.externalId },
    select: { id: true, name: true },
  });
  if (!group) {
    return; // default group not modeled in Hermes
  }

  // Idempotent: leave any existing active grant untouched.
  const active = await prisma.userAccess.findFirst({
    where: { userId: user.userId, groupId: group.id, isActive: true },
  });
  if (active) {
    return;
  }

  try {
    await prisma.userAccess.create({
      data: {
        userId: user.userId,
        userName: user.userName,
        userEmail: user.userEmail,
        groupId: group.id,
        levelId: null,
        externalUserId: user.externalUserId ?? null,
        isActive: true,
        grantedAt: new Date(),
        expiresAt: null, // permanent — mirrors Redash's automatic default membership
        grantedBy: 'system_default',
        accessRequestId: null,
      },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      logger.info(
        { userId: user.userId, platform, groupId: group.id },
        'Default group membership already exists (swallowed unique constraint violation)',
      );
      return;
    }
    throw err;
  }
  await prisma.auditEntry.create({
    data: {
      action: 'ACCESS_GRANTED',
      performerId: 'system_default',
      performerName: 'System (default group)',
      targetUserId: user.userId,
      targetUserName: user.userName,
      details: {
        platform,
        groupId: group.id,
        groupName: group.name,
        externalUserId: user.externalUserId ?? null,
        source: 'default-group-auto-membership',
      },
    },
  });
  logger.info(
    { userId: user.userId, platform, groupId: group.id },
    'Granted built-in default group membership on account creation',
  );
}
