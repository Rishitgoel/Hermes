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
            for (const user of redashUsers) {
                await prisma_1.default.redashUser.upsert({
                    where: { email: user.email },
                    update: {
                        id: user.id,
                        name: user.name,
                        isDisabled: user.is_disabled,
                        groupIds: user.groups,
                        lastSyncedAt: now,
                    },
                    create: {
                        id: user.id,
                        name: user.name,
                        email: user.email,
                        isDisabled: user.is_disabled,
                        groupIds: user.groups,
                        lastSyncedAt: now,
                    },
                });
            }
            // Clean up users that no longer exist in Redash
            const activeEmails = redashUsers.map(u => u.email.toLowerCase());
            await prisma_1.default.redashUser.deleteMany({
                where: {
                    email: { notIn: activeEmails },
                },
            });
            // Update RedashGroup member counts based on synced users cache
            const allCachedUsers = await prisma_1.default.redashUser.findMany();
            for (const group of redashGroups) {
                const count = allCachedUsers.filter(u => u.groupIds.includes(group.id)).length;
                await prisma_1.default.redashGroup.update({
                    where: { id: group.id },
                    data: { memberCount: count },
                });
            }
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
