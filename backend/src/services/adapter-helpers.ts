import prisma from '../config/prisma';
import logger from '../utils/logger';

/** Minimal per-user shape both adapters can map their own user type into. */
export interface SyncedUserForWorkflow {
  externalId: string;
  email: string;
  name: string;
  isPending: boolean;
  /** Omit or false for adapters (AWS) whose user type has no disabled concept. */
  isDisabled?: boolean;
}

/**
 * Notify the user-creation workflow about every active platform user so any
 * APPROVED/AWAITING_SETUP account-creation request can advance to COMPLETED.
 * Shared by RedashProvisioner and AwsProvisioner (identical logic, differing
 * only in how each adapter maps its own user type into SyncedUserForWorkflow).
 * Loaded lazily to avoid a static import cycle (user-creation → sync → registry
 * → adapter); per-user try/catch so one failure can't break the rest of the batch.
 */
export async function notifyUserCreationWorkflow(
  platform: string,
  users: SyncedUserForWorkflow[],
): Promise<void> {
  const tracked = await prisma.userCreationRequest.findMany({
    where: { platform },
    select: { userEmail: true },
  });
  if (tracked.length === 0) {
    return;
  }
  const trackedEmails = new Set(tracked.map(r => r.userEmail.toLowerCase()));

  const { default: userCreationService } = await import(
    './user-creation.service'
  );
  for (const u of users) {
    if (u.isDisabled) {
      continue;
    }
    if (!trackedEmails.has(u.email.toLowerCase())) {
      continue;
    }
    try {
      await userCreationService.handlePlatformUserDetected(platform, {
        externalId: u.externalId,
        email: u.email,
        name: u.name,
        isPending: u.isPending,
      });
    } catch (err: any) {
      logger.error(
        {
          platform,
          externalId: u.externalId,
          email: u.email,
          error: err.message,
        },
        'handlePlatformUserDetected failed for one user; continuing batch',
      );
    }
  }
}

/** Recompute and persist member counts for every cached group of one platform. */
export async function recomputeGroupMemberCounts(
  platform: string,
): Promise<void> {
  const [groups, users] = await Promise.all([
    prisma.platformExternalGroup.findMany({
      where: { platform },
      select: { id: true, externalId: true },
    }),
    prisma.platformExternalUser.findMany({
      where: { platform },
      select: { externalGroupIds: true },
    }),
  ]);
  const counts = new Map<string, number>();
  for (const u of users) {
    for (const gid of u.externalGroupIds) {
      counts.set(gid, (counts.get(gid) ?? 0) + 1);
    }
  }
  const updates = groups.map(group =>
    prisma.platformExternalGroup.update({
      where: { id: group.id },
      data: { memberCount: counts.get(group.externalId) ?? 0 },
    }),
  );
  if (updates.length) {
    await prisma.$transaction(updates);
  }
}
