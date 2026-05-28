import prisma from '../config/prisma';
import redashService from './redash.service';
import userCreationService from './user-creation.service';
import logger from '../utils/logger';

export class SyncService {
  private lastSyncedAt: Date | null = null;

  getLastSyncedAt(): Date | null {
    return this.lastSyncedAt;
  }

  async syncWithRedash(): Promise<{ usersSynced: number; groupsSynced: number }> {
    logger.info('🔄 SyncService: Starting Redash synchronization...');
    const now = new Date();

    try {
      // 1. Sync Groups
      const redashGroups = await redashService.syncGroups();
      logger.info(`🔄 SyncService: Fetched ${redashGroups.length} groups from Redash.`);

      for (const group of redashGroups) {
        await prisma.redashGroup.upsert({
          where: { id: group.id },
          update: {
            name: group.name,
            type: group.type,
            lastSyncedAt: now,
          },
          create: {
            id: group.id,
            name: group.name,
            type: group.type,
            lastSyncedAt: now,
          },
        });
      }

      // Clean up groups that no longer exist in Redash
      const activeGroupIds = redashGroups.map(g => g.id);
      await prisma.redashGroup.deleteMany({
        where: {
          id: { notIn: activeGroupIds },
        },
      });

      // 2. Sync Users
      const redashUsers = await redashService.syncUsers();
      logger.info(`🔄 SyncService: Fetched ${redashUsers.length} users from Redash.`);

      // Upsert-based sync — no destructive deletes
      for (const user of redashUsers) {
        await prisma.redashUser.upsert({
          where: { id: user.id },
          update: {
            name: user.name,
            email: user.email.toLowerCase(),
            isDisabled: user.is_disabled,
            isInvitationPending: user.is_invitation_pending,
            groupIds: user.groups,
            lastSyncedAt: now,
          },
          create: {
            id: user.id,
            name: user.name,
            email: user.email.toLowerCase(),
            isDisabled: user.is_disabled,
            isInvitationPending: user.is_invitation_pending,
            groupIds: user.groups,
            lastSyncedAt: now,
          },
        });
      }

      // Remove users that no longer exist in Redash
      const activeUserIds = redashUsers.map(u => u.id);
      await prisma.redashUser.deleteMany({
        where: { id: { notIn: activeUserIds } },
      });

      // Batch update member counts in a single transaction (fixes N+1 #27)
      const allCachedUsers = await prisma.redashUser.findMany();
      const updates = redashGroups.map(group => {
        const count = allCachedUsers.filter(u => u.groupIds.includes(group.id)).length;
        return prisma.redashGroup.update({
          where: { id: group.id },
          data: { memberCount: count },
        });
      });
      await prisma.$transaction(updates);

      // Notify user-creation workflow about every active Redash user. The handler
      // is a cheap no-op for users with no pending request; it only acts when a
      // UserCreationRequest exists in APPROVED/AWAITING_SETUP. Per-user try/catch
      // so one failure can't break the rest of the batch.
      for (const u of redashUsers) {
        if (u.is_disabled) continue;
        try {
          await userCreationService.handleRedashUserDetected({
            id: u.id,
            email: u.email,
            name: u.name,
            isInvitationPending: u.is_invitation_pending,
          });
        } catch (err: any) {
          logger.error(
            { redashUserId: u.id, email: u.email, error: err.message },
            'handleRedashUserDetected failed for one user; continuing batch',
          );
        }
      }

      this.lastSyncedAt = new Date();
      logger.info('🔄 SyncService: Redash synchronization completed successfully.');
      return {
        usersSynced: redashUsers.length,
        groupsSynced: redashGroups.length,
      };
    } catch (error: any) {
      logger.error('🔄 SyncService: Sync failed:', error.message);
      throw error;
    }
  }

  async syncSingleUser(email: string): Promise<boolean> {
    logger.info({ email }, '🔄 SyncService: Starting fast-path single user Redash synchronization...');
    try {
      const user = await redashService.fetchUserByEmail(email);
      if (!user) {
        logger.warn({ email }, '🔄 SyncService: User not found in Redash during single sync.');
        return false;
      }

      const now = new Date();
      await prisma.redashUser.upsert({
        where: { id: user.id },
        update: {
          name: user.name,
          email: user.email.toLowerCase(),
          isDisabled: user.is_disabled,
          isInvitationPending: user.is_invitation_pending,
          groupIds: user.groups,
          lastSyncedAt: now,
        },
        create: {
          id: user.id,
          name: user.name,
          email: user.email.toLowerCase(),
          isDisabled: user.is_disabled,
          isInvitationPending: user.is_invitation_pending,
          groupIds: user.groups,
          lastSyncedAt: now,
        },
      });

      if (!user.is_disabled) {
        await userCreationService.handleRedashUserDetected({
          id: user.id,
          email: user.email,
          name: user.name,
          isInvitationPending: user.is_invitation_pending,
        });
      }
      return true;
    } catch (error: any) {
      logger.error({ email, error: error.message }, '🔄 SyncService: Single user sync failed');
      return false;
    }
  }
}

export const syncService = new SyncService();
export default syncService;
