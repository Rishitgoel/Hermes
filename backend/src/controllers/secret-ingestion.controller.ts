import { Request, Response, NextFunction } from 'express';
import BaseController from './base.controller';
import prisma from '../config/prisma';
import secretIngestionService, {
  assertSecretsPlatform,
  isSecretsFamilyPlatform,
} from '../services/secret-ingestion.service';
import secretDriftService from '../services/secret-drift.service';
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
} from '../utils/errors';
import {
  submitIngestionSchema,
  submitIngestionBulkSchema,
  reviewIngestionSchema,
  infraPreviewSchema,
  resolveDriftSchema,
  driftKeySchema,
} from '../validations/secret-ingestion.validation';

/**
 * Controller for approval-gated Secret Ingestion workflows.
 */
export class SecretIngestionController extends BaseController {
  /**
   * Resolve the Secret Ingestion instance the request targets from `?platform=` (validated
   * against the configured secrets family). Undefined ⇒ the service defaults to prod (`secrets`).
   */
  private resolvePlatform(): string | undefined {
    const raw = (this.req.query.platform as string) || undefined;
    return raw ? assertSecretsPlatform(raw) : undefined;
  }

  /**
   * Same as resolvePlatform(), but for the `mine` scope only: validates against every
   * CONFIGURED instance (enabled or not), not just enabled ones. `listIngestionRequests('mine')`
   * deliberately queries every configured instance so a user's history from a since-disabled
   * instance (e.g. secrets-sandbox env vars unset post-go-live) never disappears — validating
   * the query param against the enabled-only list here would defeat that by 400ing before the
   * service ever runs.
   */
  private resolveMinePlatform(): string | undefined {
    const raw = (this.req.query.platform as string) || undefined;
    if (!raw) {
      return undefined;
    }
    const key = raw.toLowerCase();
    if (!isSecretsFamilyPlatform(key)) {
      throw new ValidationError(
        `"${raw}" is not a configured Secret Ingestion instance.`,
      );
    }
    return key;
  }

  // GET /api/secrets/scope[?platform=secrets-sandbox]
  async getScope(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) {
        return;
      }
      const scope = await secretIngestionService.getUserScope(
        userId,
        this.resolvePlatform(),
      );
      this.sendResponse(scope, 'Secret scope retrieved');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve secret scope');
    }
  }

  // GET /api/secrets/keys?name=payment/gateway[&platform=secrets-sandbox]
  async listKeys(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) {
        return;
      }
      const secretName = ((this.req.query.name as string) || '').trim();
      const result = await secretIngestionService.listSecretKeys(
        userId,
        secretName,
        this.resolvePlatform(),
      );
      this.sendResponse(result, 'Secret keys retrieved');
    } catch (error) {
      this.handleError(error, 'Failed to retrieve secret keys');
    }
  }

  // POST /api/secrets/requests/infra-preview — which manifests would change (compose screen)
  async previewInfra(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const validated = this.validateWithZod(infraPreviewSchema, this.req.body);
      if (!validated.success) {
        return;
      }
      const userId = this.getUserId();
      if (!userId) {
        return;
      }
      const platform = validated.data.platform
        ? assertSecretsPlatform(validated.data.platform)
        : undefined;
      const result = await secretIngestionService.previewInfraTargets(
        userId,
        validated.data.secretName,
        validated.data.keys,
        platform,
      );
      this.sendResponse(result, 'Infra deployment targets resolved');
    } catch (error) {
      this.handleError(error, 'Failed to resolve infra deployment targets');
    }
  }

  // POST /api/secrets/requests
  async submitRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const validated = this.validateWithZod(
        submitIngestionSchema,
        this.req.body,
      );
      if (!validated.success) {
        return;
      }
      const userId = this.getUserId();
      if (!userId) {
        return;
      }
      const row = await secretIngestionService.createIngestionRequest({
        requester: this.user!,
        secretName: validated.data.secretName,
        entries: validated.data.entries,
        justification: validated.data.justification,
        infraTargets: validated.data.infraTargets,
        platform: validated.data.platform,
      });
      this.sendResponse(row, 'Secret ingestion request submitted', 201);
    } catch (error) {
      this.handleError(error, 'Failed to submit secret ingestion request');
    }
  }

  // POST /api/secrets/requests/bulk — multi-secret cart checkout. Fans out to one request per
  // secret sharing a batchId; partial success comes back as { submitted, failed }.
  async submitRequestsBulk(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const validated = this.validateWithZod(
        submitIngestionBulkSchema,
        this.req.body,
      );
      if (!validated.success) {
        return;
      }
      const userId = this.getUserId();
      if (!userId) {
        return;
      }
      const result = await secretIngestionService.createIngestionRequestsBulk({
        requester: this.user!,
        platform: validated.data.platform,
        secrets: validated.data.secrets,
      });
      this.sendResponse(result, 'Secret ingestion requests submitted', 201);
    } catch (error) {
      this.handleError(error, 'Failed to submit secret ingestion requests');
    }
  }

  // GET /api/secrets/requests?scope=mine|review
  async listRequests(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) {
        return;
      }
      const scope = this.req.query.scope === 'review' ? 'review' : 'mine';
      const platform =
        scope === 'mine' ? this.resolveMinePlatform() : this.resolvePlatform();
      const rows = await secretIngestionService.listIngestionRequests(
        this.user!,
        scope,
        platform,
      );
      this.sendResponse(rows, 'Secret ingestion requests retrieved');
    } catch (error) {
      this.handleError(error, 'Failed to list secret ingestion requests');
    }
  }

  // GET /api/secrets/drift[?platform=secrets] — admin drift report (AWS keys vs infra manifests)
  async getDrift(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const report = await secretDriftService.detectDrift(
        this.user!,
        this.resolvePlatform() ?? 'secrets',
      );
      this.sendResponse(report, 'Secret drift report generated');
    } catch (error) {
      this.handleError(error, 'Failed to generate secret drift report');
    }
  }

  // POST /api/secrets/drift/resolve — open a draft PR registering the missing keys for one secret
  async resolveDrift(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const validated = this.validateWithZod(resolveDriftSchema, this.req.body);
      if (!validated.success) {
        return;
      }
      const platform = validated.data.platform
        ? assertSecretsPlatform(validated.data.platform)
        : undefined;
      const result = await secretDriftService.resolveDrift(
        this.user!,
        validated.data.secretName,
        platform ?? 'secrets',
      );
      this.sendResponse(result, 'Drift reconciliation PR opened');
    } catch (error) {
      this.handleError(error, 'Failed to reconcile secret drift');
    }
  }

  // POST /api/secrets/drift/merge — merge the draft PR opened by resolveDrift, after a human
  // reviewed it on GitHub. Available regardless of the auto-merge toggle: that setting decides
  // whether Hermes merges unattended, not whether an admin may merge from here.
  async mergeDrift(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const validated = this.validateWithZod(resolveDriftSchema, this.req.body);
      if (!validated.success) {
        return;
      }
      const platform = validated.data.platform
        ? assertSecretsPlatform(validated.data.platform)
        : undefined;
      const result = await secretDriftService.mergeDrift(
        this.user!,
        validated.data.secretName,
        platform ?? 'secrets',
      );
      // A GitHub refusal comes back as a FAILED result, not a thrown error — the response is
      // still a 200 carrying the reason, so the UI can offer the merge-on-GitHub fallback.
      this.sendResponse(
        result,
        result.state === 'MERGED'
          ? 'Drift reconciliation PR merged'
          : 'Drift reconciliation PR merge attempted',
      );
    } catch (error) {
      this.handleError(error, 'Failed to merge secret drift PR');
    }
  }

  // POST /api/secrets/drift/ignore — stop notifying about one missingInAws (dangling) key
  async ignoreDriftKey(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const validated = this.validateWithZod(driftKeySchema, this.req.body);
      if (!validated.success) {
        return;
      }
      const platform = validated.data.platform
        ? assertSecretsPlatform(validated.data.platform)
        : undefined;
      const result = await secretDriftService.ignoreDriftKey(
        this.user!,
        validated.data.secretName,
        validated.data.key,
        platform ?? 'secrets',
      );
      this.sendResponse(result, 'Drift key ignored');
    } catch (error) {
      this.handleError(error, 'Failed to ignore drift key');
    }
  }

  // POST /api/secrets/drift/unignore — resume notifications for a previously-ignored key
  async unignoreDriftKey(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const validated = this.validateWithZod(driftKeySchema, this.req.body);
      if (!validated.success) {
        return;
      }
      const platform = validated.data.platform
        ? assertSecretsPlatform(validated.data.platform)
        : undefined;
      const result = await secretDriftService.unignoreDriftKey(
        this.user!,
        validated.data.secretName,
        validated.data.key,
        platform ?? 'secrets',
      );
      this.sendResponse(result, 'Drift key un-ignored');
    } catch (error) {
      this.handleError(error, 'Failed to un-ignore drift key');
    }
  }

  // PUT /api/secrets/requests/:id/review
  async reviewRequest(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const validated = this.validateWithZod(
        reviewIngestionSchema,
        this.req.body,
      );
      if (!validated.success) {
        return;
      }
      const userId = this.getUserId();
      if (!userId) {
        return;
      }
      const id = this.req.params.id as string;

      const row = await prisma.secretIngestionRequest.findUnique({
        where: { id },
        select: { groupId: true, platform: true },
      });
      if (!row) {
        throw new NotFoundError('Secret ingestion request not found');
      }
      if (!(await secretIngestionService.canReview(this.user!, row))) {
        throw new AuthorizationError(
          'You do not have permission to review this secret ingestion request.',
        );
      }

      const reviewer = { id: userId, username: this.user!.username };
      const updated = await secretIngestionService.reviewIngestionRequest(
        id,
        reviewer,
        validated.data.decisions,
        validated.data.note,
      );
      this.sendResponse(updated, 'Secret ingestion request reviewed');
    } catch (error) {
      this.handleError(error, 'Failed to review secret ingestion request');
    }
  }

  // POST /api/secrets/requests/:id/retry-merge — retry a stuck deployment PR merge (e.g. after
  // GitHub branch protection blocked the auto-merge and a human has since unblocked it)
  async retryMerge(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) {
        return;
      }
      const id = this.req.params.id as string;

      const row = await prisma.secretIngestionRequest.findUnique({
        where: { id },
        select: { groupId: true, platform: true },
      });
      if (!row) {
        throw new NotFoundError('Secret ingestion request not found');
      }
      if (!(await secretIngestionService.canReview(this.user!, row))) {
        throw new AuthorizationError(
          'You do not have permission to retry this secret ingestion request.',
        );
      }

      const updated = await secretIngestionService.retryInfraMerge(id);
      this.sendResponse(updated, 'Deployment PR merge retried');
    } catch (error) {
      this.handleError(error, 'Failed to retry deployment PR merge');
    }
  }

  // POST /api/secrets/requests/:id/dismiss-merge — dismiss a stuck deployment PR merge (e.g. mark it CLOSED
  // in the database and close the PR on GitHub)
  async dismissMerge(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId = this.getUserId();
      if (!userId) {
        return;
      }
      const id = this.req.params.id as string;

      const row = await prisma.secretIngestionRequest.findUnique({
        where: { id },
        select: { groupId: true, platform: true },
      });
      if (!row) {
        throw new NotFoundError('Secret ingestion request not found');
      }
      if (!(await secretIngestionService.canReview(this.user!, row))) {
        throw new AuthorizationError(
          'You do not have permission to dismiss this secret ingestion request.',
        );
      }

      const updated = await secretIngestionService.dismissInfraMerge(id);
      this.sendResponse(updated, 'Deployment PR merge dismissed');
    } catch (error) {
      this.handleError(error, 'Failed to dismiss deployment PR merge');
    }
  }
}
