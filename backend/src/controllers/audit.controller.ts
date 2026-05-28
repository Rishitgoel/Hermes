import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import prisma from '../config/prisma';
import { AuthorizationError } from '../utils/errors';
import { auditQuerySchema } from '../validations/audit.validation';

export class AuditController extends BaseController {
  // GET /api/audit
  async getAuditLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      // Authorization Check: Super Admin only
      const isSuperAdmin = this.user!.roles.includes('hermes_super_admin');
      if (!isSuperAdmin) {
        throw new AuthorizationError('Only super admins can view platform audit logs');
      }

      const pagination = this.validatePagination();
      if (!pagination) return;

      const { pageNo, pageSize } = pagination;
      const skip = (pageNo - 1) * pageSize;

      // Optional filters
      const queryResult = this.validateWithZod(auditQuerySchema, this.req.query, 'Invalid query parameters');
      if (!queryResult.success) return;
      const { action, search } = queryResult.data;
      
      const where: any = {};
      
      if (action) {
        where.action = action as string;
      }
      
      if (search) {
        where.OR = [
          { performerName: { contains: search as string, mode: 'insensitive' } },
          { targetUserName: { contains: search as string, mode: 'insensitive' } },
        ];
      }

      const [logs, total] = await Promise.all([
        prisma.auditEntry.findMany({
          where,
          skip,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
        }),
        prisma.auditEntry.count({ where }),
      ]);

      this.sendPaginatedResponse(logs, total, pagination, 'Audit logs retrieved successfully');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve audit logs');
    }
  }
}
