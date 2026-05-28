import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import syncService from '../services/sync.service';
import prisma from '../config/prisma';
import { AuthorizationError } from '../utils/errors';
import logger from '../utils/logger';

export class AdminController extends BaseController {
  // POST /api/admin/sync
  async triggerSync(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      const isSuperAdmin = this.user!.roles.includes('hermes_super_admin');
      if (!isSuperAdmin) {
        throw new AuthorizationError('Only super admins can trigger manual synchronization');
      }

      logger.info(`Super admin ${this.user!.username} triggered manual Redash sync`);
      const syncResult = await syncService.syncWithRedash();

      // Create Audit Log entry
      await prisma.auditEntry.create({
        data: {
          action: 'MANUAL_SYNC_TRIGGERED',
          performerId: userId,
          performerName: this.user!.username,
          details: { ...syncResult },
        },
      });

      this.sendResponse(syncResult, 'Redash synchronization completed successfully');
    } catch (error) {
      this.handleError(error, 'Synchronization triggered manual task failure');
    }
  }
}
