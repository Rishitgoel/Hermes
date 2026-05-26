"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminController = void 0;
const base_controller_1 = __importDefault(require("./base.controller"));
const sync_service_1 = __importDefault(require("../services/sync.service"));
const prisma_1 = __importDefault(require("../config/prisma"));
const errors_1 = require("../utils/errors");
const logger_1 = __importDefault(require("../utils/logger"));
class AdminController extends base_controller_1.default {
    // POST /api/admin/sync
    async triggerSync(req, res, next) {
        try {
            const userId = this.getUserId();
            if (!userId)
                return;
            const isSuperAdmin = this.user.roles.includes('atlas_super_admin');
            if (!isSuperAdmin) {
                throw new errors_1.AuthorizationError('Only super admins can trigger manual synchronization');
            }
            logger_1.default.info(`Super admin ${this.user.username} triggered manual Redash sync`);
            const syncResult = await sync_service_1.default.syncWithRedash();
            // Create Audit Log entry
            await prisma_1.default.auditEntry.create({
                data: {
                    action: 'MANUAL_SYNC_TRIGGERED',
                    performerId: userId,
                    performerName: this.user.username,
                    details: { ...syncResult },
                },
            });
            this.sendResponse(syncResult, 'Redash synchronization completed successfully');
        }
        catch (error) {
            this.handleError(error, 'Synchronization triggered manual task failure');
        }
    }
}
exports.AdminController = AdminController;
