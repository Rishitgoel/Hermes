import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import syncService from '../services/sync.service';
import adminReconciliationService from '../services/admin-reconciliation.service';
import { importRedashMemberships } from '../services/redash-import.service';
import { migrateZookeeperAcls } from '../services/zookeeper-migration.service';
import prisma from '../config/prisma';
import { AuthorizationError } from '../utils/errors';
import { isSuperAdmin } from '../utils/authz';
import logger from '../utils/logger';

export class AdminController extends BaseController {
  // POST /api/admin/sync[?platform=redash]
  // With ?platform set, syncs only that platform; otherwise syncs all registered platforms.
  async triggerSync(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      if (!isSuperAdmin(this.user!)) {
        throw new AuthorizationError('Only super admins can trigger manual synchronization');
      }

      const platform = typeof req.query.platform === 'string' ? req.query.platform : undefined;

      logger.info(
        `Super admin ${this.user!.username} triggered manual platform sync${platform ? ` (${platform})` : ''}`,
      );
      const syncResult = platform
        ? await syncService.syncSinglePlatform(platform)
        : await syncService.syncAllPlatforms();

      // Create Audit Log entry
      await prisma.auditEntry.create({
        data: {
          action: 'MANUAL_SYNC_TRIGGERED',
          performerId: userId,
          performerName: this.user!.username,
          details: { ...syncResult, platform: platform ?? 'all' },
        },
      });

      this.sendResponse(syncResult, 'Platform synchronization completed successfully');
    } catch (error) {
      this.handleError(error, 'Synchronization triggered manual task failure');
    }
  }

  // POST /api/admin/reconcile[?dryRun=true]
  // Force a Keycloak↔mirror reconciliation for platform/group admins (super only).
  // dryRun=true reports the drift without writing anything.
  async triggerReconcile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      if (!isSuperAdmin(this.user!)) {
        throw new AuthorizationError('Only super admins can trigger admin reconciliation');
      }

      const dryRun = req.query.dryRun === 'true';
      logger.info(
        `Super admin ${this.user!.username} triggered manual admin reconciliation${dryRun ? ' (dry-run)' : ''}`,
      );
      const result = await adminReconciliationService.reconcileAll({ dryRun });

      // Only audit real (non-dry-run) reconciliations — a dry-run changes nothing.
      if (!dryRun) {
        await prisma.auditEntry.create({
          data: {
            action: 'ADMIN_RECONCILE_TRIGGERED',
            performerId: userId,
            performerName: this.user!.username,
            details: result as object,
          },
        });
      }

      this.sendResponse(
        result,
        dryRun ? 'Admin reconciliation dry-run completed (no changes made)' : 'Admin reconciliation completed successfully',
      );
    } catch (error) {
      this.handleError(error, 'Admin reconciliation failed');
    }
  }

  // POST /api/admin/import-redash-memberships  body: { apply?: boolean }
  // Maintenance tool (super admin only): backfill existing Redash accounts +
  // memberships into Hermes so users keep access they already have. Dry-run unless
  // apply === true. Idempotent. Surfaced in a collapsed disclosure in the UI.
  async importRedashMemberships(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      if (!isSuperAdmin(this.user!)) {
        throw new AuthorizationError('Only super admins can import Redash memberships');
      }

      const apply = req.body?.apply === true;
      logger.info(
        `Super admin ${this.user!.username} triggered Redash membership import${apply ? ' (APPLY)' : ' (dry-run)'}`,
      );
      const report = await importRedashMemberships({
        apply,
        performerId: userId,
        performerName: this.user!.username,
      });

      // Only audit a real (apply) run — a dry-run writes nothing. Per-grant
      // ACCESS_IMPORTED entries are written inside the service.
      if (apply) {
        await prisma.auditEntry.create({
          data: {
            action: 'REDASH_IMPORT_TRIGGERED',
            performerId: userId,
            performerName: this.user!.username,
            details: report as object,
          },
        });
      }

      this.sendResponse(
        report,
        apply
          ? 'Redash membership import completed'
          : 'Redash membership import dry-run completed (no changes made)',
      );
    } catch (error) {
      this.handleError(error, 'Redash membership import failed');
    }
  }

  // POST /api/admin/migrate-zookeeper-acls  body: { apply?: boolean }
  // Maintenance tool (super admin only): migrate existing ZooKeeper ACLs to world-open (world:anyone:cdrwa).
  // Dry-run unless apply === true.
  async migrateZookeeperAcls(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;

      if (!isSuperAdmin(this.user!)) {
        throw new AuthorizationError('Only super admins can migrate ZooKeeper ACLs');
      }

      const apply = req.body?.apply === true;
      logger.info(
        `Super admin ${this.user!.username} triggered ZooKeeper ACL migration${apply ? ' (APPLY)' : ' (dry-run)'}`,
      );
      const report = await migrateZookeeperAcls({
        apply,
        performerId: userId,
        performerName: this.user!.username,
      });

      if (apply) {
        await prisma.auditEntry.create({
          data: {
            action: 'ZOOKEEPER_MIGRATION_TRIGGERED',
            performerId: userId,
            performerName: this.user!.username,
            details: report as any,
          },
        });
      }

      this.sendResponse(
        report,
        apply
          ? 'ZooKeeper ACL migration completed'
          : 'ZooKeeper ACL migration dry-run completed (no changes made)',
      );
    } catch (error) {
      this.handleError(error, 'ZooKeeper ACL migration failed');
    }
  }
}
