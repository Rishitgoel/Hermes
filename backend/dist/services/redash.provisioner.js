"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.redashProvisioner = exports.RedashProvisioner = void 0;
const redash_service_1 = __importDefault(require("./redash.service"));
const prisma_1 = __importDefault(require("../config/prisma"));
class RedashProvisioner {
    platform = 'redash';
    async provision(ctx) {
        const redashUserId = await redash_service_1.default.findOrInviteUser(ctx.email, ctx.name);
        if (ctx.externalGroupId) {
            await redash_service_1.default.addUserToGroup(redashUserId, parseInt(ctx.externalGroupId, 10));
        }
        return { externalUserId: redashUserId.toString() };
    }
    async deprovision(ctx) {
        if (ctx.externalGroupId) {
            await redash_service_1.default.removeUserFromGroup(parseInt(ctx.externalUserId, 10), parseInt(ctx.externalGroupId, 10));
        }
    }
    async checkUserStatus(email) {
        const redashUser = await prisma_1.default.redashUser.findUnique({
            where: { email: email.toLowerCase() },
        });
        return {
            exists: !!redashUser,
            externalUserId: redashUser?.id?.toString(),
            email,
        };
    }
    async inviteUser(email, name) {
        const redashUserId = await redash_service_1.default.findOrInviteUser(email, name);
        await prisma_1.default.redashUser.upsert({
            where: { email: email.toLowerCase() },
            update: {
                name,
                lastSyncedAt: new Date(),
            },
            create: {
                id: redashUserId,
                name,
                email: email.toLowerCase(),
                isDisabled: false,
                groupIds: [1],
                lastSyncedAt: new Date(),
            },
        });
        return { externalUserId: redashUserId.toString() };
    }
    async healthCheck() {
        try {
            await redash_service_1.default.syncGroups(); // lightweight probe
            return { healthy: true };
        }
        catch (err) {
            return { healthy: false, message: err.message };
        }
    }
}
exports.RedashProvisioner = RedashProvisioner;
exports.redashProvisioner = new RedashProvisioner();
exports.default = exports.redashProvisioner;
