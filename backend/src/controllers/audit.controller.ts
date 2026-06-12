import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import BaseController from './base.controller';
import prisma from '../config/prisma';
import { AuthorizationError, ValidationError } from '../utils/errors';
import { isSuperAdmin } from '../utils/authz';
import { auditQuerySchema } from '../validations/audit.validation';

export class AuditController extends BaseController {
  /**
   * Parse a filter date string. Accepts a date-only value ("2026-06-01", as emitted
   * by <input type="date">) or a full ISO timestamp. For an inclusive upper bound we
   * expand a date-only value to the end of that UTC day; otherwise we use it verbatim.
   */
  private parseFilterDate(value: string, endOfDay: boolean): Date {
    const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const iso = isDateOnly ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : value;
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
      throw new ValidationError(`Invalid date filter: "${value}"`);
    }
    return d;
  }

  // GET /api/audit
  async getAuditLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      // Authorization Check: Super Admin only
      if (!isSuperAdmin(this.user!)) {
        throw new AuthorizationError('Only super admins can view platform audit logs');
      }

      const pagination = this.validatePagination();
      if (!pagination) return;

      const { pageNo, pageSize } = pagination;
      const skip = (pageNo - 1) * pageSize;

      // Optional filters
      const queryResult = this.validateWithZod(auditQuerySchema, this.req.query, 'Invalid query parameters');
      if (!queryResult.success) return;
      const { action, search, performerId, groupId, platform, fromDate, toDate } = queryResult.data;

      const where: Prisma.AuditEntryWhereInput = {};

      if (action) {
        where.action = action;
      }

      if (performerId) {
        where.performerId = performerId;
      }

      if (search) {
        where.OR = [
          { performerName: { contains: search, mode: 'insensitive' } },
          { targetUserName: { contains: search, mode: 'insensitive' } },
        ];
      }

      // Date range on createdAt (inclusive bounds). When both are provided, reject toDate < fromDate.
      if (fromDate || toDate) {
        const createdAt: Prisma.DateTimeFilter = {};
        if (fromDate) createdAt.gte = this.parseFilterDate(fromDate, false);
        if (toDate) createdAt.lte = this.parseFilterDate(toDate, true);
        if (createdAt.gte && createdAt.lte && (createdAt.lte as Date) < (createdAt.gte as Date)) {
          throw new ValidationError('toDate must be on or after fromDate');
        }
        where.createdAt = createdAt;
      }

      // Group / platform scoping. AuditEntry stores groupId but not platform, so a
      // platform filter is resolved to the ids of that platform's groups. An explicit
      // groupId is the more specific filter and wins; when both are given we still
      // constrain to a single group (and ignore platform).
      if (groupId) {
        where.groupId = groupId;
      } else if (platform) {
        const platformGroups = await prisma.group.findMany({
          where: { platform: platform.toLowerCase() },
          select: { id: true },
        });
        // No groups on that platform → no entry can match. `in: []` yields an empty set.
        where.groupId = { in: platformGroups.map((g) => g.id) };
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
