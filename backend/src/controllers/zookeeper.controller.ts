import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import prisma from '../config/prisma';
import zookeeperConfigService from '../services/zookeeper-config.service';
import { AuthorizationError, NotFoundError } from '../utils/errors';
import { submitZkChangeSchema, reviewZkChangeSchema } from '../validations/zookeeper.validation';

/**
 * Approval-based ZooKeeper config management. All routes are `authenticateToken`;
 * fine-grained authorization is here (the user-creation.controller pattern):
 *  - browse/export/submit → the service scopes to the caller's active ZK grants;
 *  - review → super admin, or group admin of the request's group.
 */
export class ZookeeperController extends BaseController {
  // GET /api/zookeeper/scope — the user's active ZK groups + paths (seeds the UI).
  async getScope(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;
      const scope = await zookeeperConfigService.getUserScope(userId);
      this.sendResponse(scope, 'ZooKeeper scope retrieved');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve ZooKeeper scope');
    }
  }

  // GET /api/zookeeper/nodes?path=/hermes/credit-card
  async browseNode(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;
      const path = ((this.req.query.path as string) || '/').trim();
      const result = await zookeeperConfigService.browseNode(userId, path);
      this.sendResponse(result, 'ZooKeeper node retrieved');
    } catch (error) {
      this.handleError(error, 'Failed to browse ZooKeeper node');
    }
  }

  // GET /api/zookeeper/export?path=/hermes
  async exportSubtree(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;
      const path = ((this.req.query.path as string) || '').trim();
      const content = await zookeeperConfigService.exportSubtree(userId, path);
      this.sendResponse({ path, content }, 'ZooKeeper subtree exported');
    } catch (error) {
      this.handleError(error, 'Failed to export ZooKeeper subtree');
    }
  }

  // POST /api/zookeeper/requests
  async submitChangeRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = this.validateWithZod(submitZkChangeSchema, this.req.body);
      if (!validated.success) return;
      const userId = this.getUserId();
      if (!userId) return;
      const requester = { id: userId, username: this.user!.username, email: this.user!.email };
      const rows = await zookeeperConfigService.createChangeRequest({
        requester,
        changes: validated.data.changes,
        justification: validated.data.justification,
      });
      this.sendResponse(rows, 'Change request submitted', 201);
    } catch (error) {
      this.handleError(error, 'Failed to submit change request');
    }
  }

  // GET /api/zookeeper/requests?scope=mine|review
  async listRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) return;
      const scope = this.req.query.scope === 'review' ? 'review' : 'mine';
      const rows = await zookeeperConfigService.listChangeRequests(this.user!, scope);
      this.sendResponse(rows, 'Change requests retrieved');
    } catch (error) {
      this.handleError(error, 'Failed to list change requests');
    }
  }

  // PUT /api/zookeeper/requests/:id/review
  async reviewRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validated = this.validateWithZod(reviewZkChangeSchema, this.req.body);
      if (!validated.success) return;
      const userId = this.getUserId();
      if (!userId) return;
      const id = this.req.params.id as string;

      // Authorize: super / ZooKeeper platform admin / group admin of ANY group the
      // request touches (a request can span several groups → reviewable by all involved).
      const row = await prisma.zookeeperChangeRequest.findUnique({ where: { id }, select: { groupIds: true } });
      if (!row) throw new NotFoundError('Change request not found');
      if (!(await zookeeperConfigService.canReview(this.user!, row))) {
        throw new AuthorizationError('You do not have permission to review this change request.');
      }

      const reviewer = { id: userId, username: this.user!.username };
      const updated = await zookeeperConfigService.reviewChangeRequest(
        id,
        reviewer,
        validated.data.decisions,
        validated.data.note,
      );
      this.sendResponse(updated, 'Change request reviewed');
    } catch (error) {
      this.handleError(error, 'Failed to review change request');
    }
  }
}

export default ZookeeperController;
