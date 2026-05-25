"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const base_controller_1 = __importDefault(require("./base.controller"));
class AuthController extends base_controller_1.default {
    // GET /auth/me
    async getMe(req, res, next) {
        try {
            if (!this.user) {
                this.sendErrorResponse('User session not found', 401);
                return;
            }
            this.sendResponse(this.user, 'Session authenticated successfully');
        }
        catch (error) {
            this.handleError(error, 'Failed to authenticate session');
        }
    }
}
exports.AuthController = AuthController;
exports.default = AuthController;
