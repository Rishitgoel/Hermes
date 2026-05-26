"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditController = void 0;
const base_controller_1 = __importDefault(require("./base.controller"));
const prisma_1 = __importDefault(require("../config/prisma"));
const errors_1 = require("../utils/errors");
const audit_validation_1 = require("../validations/audit.validation");
class AuditController extends base_controller_1.default {
    // GET /api/audit
    async getAuditLogs(req, res, next) {
        try {
            const userId = this.getUserId();
            if (!userId)
                return;
            // Authorization Check: Super Admin only
            const isSuperAdmin = this.user.roles.includes('atlas_super_admin');
            if (!isSuperAdmin) {
                throw new errors_1.AuthorizationError('Only super admins can view platform audit logs');
            }
            const pagination = this.validatePagination();
            if (!pagination)
                return;
            const { pageNo, pageSize } = pagination;
            const skip = (pageNo - 1) * pageSize;
            // Optional filters
            const queryResult = this.validateWithZod(audit_validation_1.auditQuerySchema, this.req.query, 'Invalid query parameters');
            if (!queryResult.success)
                return;
            const { action, search } = queryResult.data;
            const where = {};
            if (action) {
                where.action = action;
            }
            if (search) {
                where.OR = [
                    { performerName: { contains: search, mode: 'insensitive' } },
                    { targetUserName: { contains: search, mode: 'insensitive' } },
                ];
            }
            const [logs, total] = await Promise.all([
                prisma_1.default.auditEntry.findMany({
                    where,
                    skip,
                    take: pageSize,
                    orderBy: { createdAt: 'desc' },
                }),
                prisma_1.default.auditEntry.count({ where }),
            ]);
            this.sendPaginatedResponse(logs, total, pagination, 'Audit logs retrieved successfully');
        }
        catch (error) {
            this.handleError(error, 'Failed to retrieve audit logs');
        }
    }
}
exports.AuditController = AuditController;
