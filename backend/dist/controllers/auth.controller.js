"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const base_controller_1 = __importDefault(require("./base.controller"));
const user_creation_service_1 = __importDefault(require("../services/user-creation.service"));
const logger_1 = __importDefault(require("../utils/logger"));
class AuthController extends base_controller_1.default {
    // GET /auth/me
    // Returns the authenticated user plus their UserCreationRequest summary.
    // ensureDraftForUser is called here as the explicit, lazy auto-create hook —
    // we want exactly one row per Keycloak user, created lazily on first session load.
    async getMe(req, res, next) {
        try {
            if (!this.user) {
                this.sendErrorResponse('User session not found', 401);
                return;
            }
            let userCreation = null;
            try {
                const row = await user_creation_service_1.default.ensureDraftForUser({
                    id: this.user.id,
                    username: this.user.username,
                    email: this.user.email,
                });
                userCreation = {
                    id: row.id,
                    status: row.status,
                    justification: row.justification,
                    submittedAt: row.submittedAt,
                    approvedAt: row.approvedAt,
                    inviteSentAt: row.inviteSentAt,
                    inviteError: row.inviteError,
                    inviteLink: row.inviteLink,
                    completedAt: row.completedAt,
                    externalUserId: row.externalUserId,
                    rejectionReason: row.rejectionReason,
                    reviewerName: row.reviewerName,
                    reviewedAt: row.reviewedAt,
                };
            }
            catch (err) {
                // Don't fail /auth/me if the user-creation lookup blows up — log and continue.
                logger_1.default.error({ err: err.message, userId: this.user.id }, 'ensureDraftForUser failed in /auth/me');
            }
            this.sendResponse({ ...this.user, userCreation }, 'Session authenticated successfully');
        }
        catch (error) {
            this.handleError(error, 'Failed to authenticate session');
        }
    }
}
exports.AuthController = AuthController;
exports.default = AuthController;
