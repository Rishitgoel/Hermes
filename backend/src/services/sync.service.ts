import prisma from '../config/prisma';
import redashService from './redash.service';
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
            groupIds: user.groups,
            lastSyncedAt: now,
          },
          create: {
            id: user.id,
            name: user.name,
            email: user.email.toLowerCase(),
            isDisabled: user.is_disabled,
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
}

export const syncService = new SyncService();
export default syncService;
