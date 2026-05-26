"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncService = exports.SyncService = void 0;
const prisma_1 = __importDefault(require("../config/prisma"));
const redash_service_1 = __importDefault(require("./redash.service"));
const logger_1 = __importDefault(require("../utils/logger"));
class SyncService {
    async syncWithRedash() {
        logger_1.default.info('🔄 SyncService: Starting Redash synchronization...');
        const now = new Date();
        try {
            // 1. Sync Groups
            const redashGroups = await redash_service_1.default.syncGroups();
            logger_1.default.info(`🔄 SyncService: Fetched ${redashGroups.length} groups from Redash.`);
            for (const group of redashGroups) {
                await prisma_1.default.redashGroup.upsert({
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
            await prisma_1.default.redashGroup.deleteMany({
                where: {
                    id: { notIn: activeGroupIds },
                },
            });
            // 2. Sync Users
            const redashUsers = await redash_service_1.default.syncUsers();
            logger_1.default.info(`🔄 SyncService: Fetched ${redashUsers.length} users from Redash.`);
            // Upsert-based sync — no destructive deletes
            for (const user of redashUsers) {
                await prisma_1.default.redashUser.upsert({
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
            await prisma_1.default.redashUser.deleteMany({
                where: { id: { notIn: activeUserIds } },
            });
            // Batch update member counts in a single transaction (fixes N+1 #27)
            const allCachedUsers = await prisma_1.default.redashUser.findMany();
            const updates = redashGroups.map(group => {
                const count = allCachedUsers.filter(u => u.groupIds.includes(group.id)).length;
                return prisma_1.default.redashGroup.update({
                    where: { id: group.id },
                    data: { memberCount: count },
                });
            });
            await prisma_1.default.$transaction(updates);
            logger_1.default.info('🔄 SyncService: Redash synchronization completed successfully.');
            return {
                usersSynced: redashUsers.length,
                groupsSynced: redashGroups.length,
            };
        }
        catch (error) {
            logger_1.default.error('🔄 SyncService: Sync failed:', error.message);
            throw error;
        }
    }
}
exports.SyncService = SyncService;
exports.syncService = new SyncService();
exports.default = exports.syncService;
