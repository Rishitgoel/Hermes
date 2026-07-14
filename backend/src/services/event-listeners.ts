import eventBus from './event-bus';
import notificationService from './notification.service';
import { ensureDefaultGroupMembership } from './default-membership.service';
import {
  SelectedTarget,
  getInfraRepoSyncService,
  isInfraAutoMergeEnabled,
  isInfraRepoEnabled,
} from './infra-repo-sync.service';
import { persistInfraResult } from './secret-ingestion.service';
import prisma from '../config/prisma';
import logger from '../utils/logger';

export function registerEventListeners(): void {
  // Wildcard audit log
  eventBus.on('*', (event) => {
    logger.info({ eventType: event.type }, `[EventBus] Event: ${event.type}`);
  });

  // Notification listeners
  eventBus.on('request.created', async (event) => {
    try {
      const { requestId, groupId, groupName, requesterName, justification, duration } = event.payload as any;
      await notificationService.notifyRequestCreated(requestId, groupId, groupName, requesterName, justification, duration);
    } catch (err: any) {
      logger.error('Failed to notify request.created event:', err.message);
    }
  });

  // Bulk submit: one consolidated notification fan-out instead of N per-request ones.
  eventBus.on('requests.bulk.created', async (event) => {
    try {
      const { requesterName, duration, items } = event.payload as any;
      await notificationService.notifyRequestsCreatedBulk(requesterName, duration, items);
    } catch (err: any) {
      logger.error('Failed to notify requests.bulk.created event:', err.message);
    }
  });

  eventBus.on('request.approved', async (event) => {
    try {
      const { requesterId, groupName, reviewerName, note, requesterEmail } = event.payload as any;
      await notificationService.notifyRequestReviewed(requesterId, groupName, true, reviewerName, note, requesterEmail);
    } catch (err: any) {
      logger.error('Failed to notify request.approved event:', err.message);
    }
  });

  eventBus.on('request.rejected', async (event) => {
    try {
      const { requesterId, groupName, reviewerName, note, requesterEmail } = event.payload as any;
      await notificationService.notifyRequestReviewed(requesterId, groupName, false, reviewerName, note, requesterEmail);
    } catch (err: any) {
      logger.error('Failed to notify request.rejected event:', err.message);
    }
  });

  eventBus.on('access.revoked', async (event) => {
    try {
      const { userId, userEmail, groupName, revokerName, reason } = event.payload as any;
      await notificationService.notifyAccessRevoked(userId, groupName, revokerName, reason, userEmail);
    } catch (err: any) {
      logger.error('Failed to notify access.revoked event:', err.message);
    }
  });

  eventBus.on('access.expired', async (event) => {
    try {
      const { userId, userEmail, groupName } = event.payload as any;
      await notificationService.notifyAccessExpired(userId, groupName, userEmail);
    } catch (err: any) {
      logger.error('Failed to notify access.expired event:', err.message);
    }
  });

  // Pre-expiry heads-up — fired once per grant by the scheduler's warning sweep.
  eventBus.on('access.expiring', async (event) => {
    try {
      const { userId, userEmail, groupName, expiresAt } = event.payload as any;
      await notificationService.notifyAccessExpiringSoon(userId, groupName, userEmail, expiresAt);
    } catch (err: any) {
      logger.error('Failed to notify access.expiring event:', err.message);
    }
  });

  // Auto-expiry permanently failed after retries — alert admins for manual cleanup.
  eventBus.on('access.expiry-failed', async (event) => {
    try {
      const { userAccessId, userName, groupName, attempts, error, platform } = event.payload as any;
      await notificationService.notifyExpiryFailed(userAccessId, userName, groupName, attempts, error, platform);
    } catch (err: any) {
      logger.error('Failed to notify access.expiry-failed event:', err.message);
    }
  });

  // Group access request approved but waiting for the user to finish platform setup
  // (fires for any platform whose invite needs a setup step — e.g. Redash).
  eventBus.on('access.queued-for-setup', async (event) => {
    try {
      const { requesterId, groupName, reviewerName, platform } = event.payload as any;
      await notificationService.notifyAccessQueuedForSetup(requesterId, groupName, reviewerName, platform);
    } catch (err: any) {
      logger.error('Failed to notify access.queued-for-setup event:', err.message);
    }
  });

  // User-creation lifecycle
  eventBus.on('user-creation.submitted', async (event) => {
    try {
      const { requestId, userName, userEmail, justification, platform } = event.payload as any;
      await notificationService.notifyUserCreationSubmitted(requestId, userName, userEmail, justification, platform);
    } catch (err: any) {
      logger.error('Failed to notify user-creation.submitted event:', err.message);
    }
  });

  eventBus.on('user-creation.invited', async (event) => {
    try {
      const { userId, userEmail, reviewerName, platform } = event.payload as any;
      await notificationService.notifyUserCreationApproved(userId, userEmail, reviewerName, platform);
    } catch (err: any) {
      logger.error('Failed to notify user-creation.invited event:', err.message);
    }
  });

  eventBus.on('user-creation.rejected', async (event) => {
    try {
      const { userId, reviewerName, note, userEmail } = event.payload as any;
      await notificationService.notifyUserCreationRejected(userId, reviewerName, note, userEmail);
    } catch (err: any) {
      logger.error('Failed to notify user-creation.rejected event:', err.message);
    }
  });

  eventBus.on('user-creation.completed', async (event) => {
    try {
      const { userId, userEmail, platform, onboardingDetails } = event.payload as any;
      await notificationService.notifyUserCreationCompleted(userId, userEmail, platform, onboardingDetails);
    } catch (err: any) {
      logger.error('Failed to notify user-creation.completed event:', err.message);
    }
  });

  // Mirror the platform's automatic built-in "default" group membership into Hermes
  // when an account is created, so newly-created users stay uniform with the users
  // backfilled by the membership import. Separate listener so a grant failure never
  // blocks the completion notification (and vice versa). No-op off Redash.
  eventBus.on('user-creation.completed', async (event) => {
    try {
      const { userId, userName, userEmail, externalUserId, platform } = event.payload as any;
      await ensureDefaultGroupMembership(platform, { userId, userName, userEmail, externalUserId });
    } catch (err: any) {
      logger.error('Failed to grant default group membership on user-creation.completed:', err.message);
    }
  });

  // ZooKeeper config change lifecycle
  eventBus.on('zk-change.submitted', async (event) => {
    try {
      const { requestId, groupIds, groupNames, requesterName, justification, changeCount } = event.payload as any;
      await notificationService.notifyZkChangeRequestCreated(requestId, groupIds, groupNames, requesterName, justification, changeCount);
    } catch (err: any) {
      logger.error('Failed to notify zk-change.submitted event:', err.message);
    }
  });

  eventBus.on('zk-change.reviewed', async (event) => {
    try {
      const { requesterId, requesterEmail, groupNames, reviewerName, note, approved, rejected, status } = event.payload as any;
      await notificationService.notifyZkChangeRequestReviewed(requesterId, requesterEmail, groupNames, status, reviewerName, note, approved, rejected);
    } catch (err: any) {
      logger.error('Failed to notify zk-change.reviewed event:', err.message);
    }
  });

  // Secret Ingestion lifecycle
  eventBus.on('secret-ingestion.submitted' as any, async (event) => {
    try {
      const { requestId, secretName, groupId, groupName, requesterName, justification, keyCount, platform } = event.payload as any;
      await notificationService.notifySecretIngestionSubmitted(requestId, groupId, groupName, secretName, requesterName, justification, keyCount, platform);
    } catch (err: any) {
      logger.error('Failed to notify secret-ingestion.submitted event:', err.message);
    }
  });

  eventBus.on('secret-ingestion.reviewed' as any, async (event) => {
    try {
      const { requestId, secretName, status, reviewerName, approvedCount, rejectedCount, failedCount } = event.payload as any;
      await notificationService.notifySecretIngestionReviewed(requestId, secretName, status, reviewerName, approvedCount, rejectedCount, failedCount);
    } catch (err: any) {
      logger.error('Failed to notify secret-ingestion.reviewed event:', err.message);
    }
  });

  // infra-deployment PR mirror — best-effort, decoupled from the AWS write. A GitHub
  // failure here never blocks Hermes; the outcome is recorded on the request row.
  eventBus.on('secret-ingestion.submitted' as any, async (event) => {
    try {
      const { requestId, secretName, platform } = event.payload as any;
      const instance = platform ?? 'secrets';
      // Each instance mirrors to its OWN infra-deployment repo; skip when that repo isn't wired
      // (the sandbox, until it's configured) — those requests write to AWS only, no PR.
      if (!isInfraRepoEnabled(instance)) return;
      const row = await prisma.secretIngestionRequest.findUnique({ where: { id: requestId } });
      if (!row) return;
      const proposedKeys = ((row.entries as any[]) || []).map(e => e.key).filter(Boolean);
      const targets = (row.infraTargets as SelectedTarget[] | null) || undefined;
      const result = await getInfraRepoSyncService(instance).openPrForRequest({
        requestId,
        secretName,
        proposedKeys,
        targets,
        requesterName: row.requesterName,
        requesterEmail: row.requesterEmail,
      });
      await persistInfraResult(requestId, result);
    } catch (err: any) {
      logger.error('Failed to open infra-deployment PR for secret ingestion:', err.message);
    }
  });

  eventBus.on('secret-ingestion.reviewed' as any, async (event) => {
    try {
      // `newApprovedKeys` (approved keys with no pre-existing AWS value, snapshotted in
      // secret-ingestion.service BEFORE the AWS write) comes from the event payload, not
      // recomputed here — entries.previousValue is deliberately never persisted to the DB
      // row (it's a live-computed display field), so re-deriving it from a re-fetched row
      // would always see it as undefined and wrongly treat every approved key as new.
      const { requestId, status, platform, newApprovedKeys: newApprovedKeysFromEvent } = event.payload as any;
      const instance = platform ?? 'secrets';
      // Each instance mirrors to its OWN infra-deployment repo; skip when that repo isn't wired
      // (the sandbox, until it's configured — see the submitted listener above).
      if (!isInfraRepoEnabled(instance)) return;
      const infra = getInfraRepoSyncService(instance);
      const row = await prisma.secretIngestionRequest.findUnique({ where: { id: requestId } });
      if (!row) return;
      const entries = (row.entries as any[]) || [];
      const approvedKeys = entries.filter(e => e.decision === 'APPROVED').map(e => e.key).filter(Boolean);
      const newApprovedKeys: string[] = ((newApprovedKeysFromEvent ?? approvedKeys) as string[]).filter(Boolean);
      const targets = (row.infraTargets as SelectedTarget[] | null) || undefined;

      if (status === 'APPLIED' || status === 'PARTIALLY_APPLIED') {
        // Ensure a PR exists (covers a submit-time open that was skipped/raced/failed),
        // then — if auto-merge is on — merge it down to just the approved keys.
        let req = row;
        if (!row.infraPrNumber) {
          const opened = await infra.openPrForRequest({
            requestId,
            secretName: row.secretName,
            proposedKeys: newApprovedKeys,
            targets,
            requesterName: row.requesterName,
            requesterEmail: row.requesterEmail,
          });
          await persistInfraResult(requestId, opened);
          if (opened.state !== 'OPEN') return;
          req = { ...row, infraPrNumber: opened.prNumber ?? null, infraBranch: opened.branch ?? null, infraPrNodeId: opened.prNodeId ?? null };
        }
        // Auto-merge OFF (default): leave the PR open for a human to review + click
        // "Merge PR" in the UI. Auto-merge ON: merge immediately, matching the original
        // always-merge behavior (now opt-in).
        if (isInfraAutoMergeEnabled(instance)) {
          const merged = await infra.mergePrForRequest({ request: req, approvedKeys, targets, newApprovedKeys });
          await persistInfraResult(requestId, merged);
        } else {
          if (req.infraPrNodeId) {
            try {
              await infra.markPrReady(req.infraPrNodeId);
            } catch (err: any) {
              logger.error(`Failed to mark PR #${req.infraPrNumber} ready:`, err.message);
            }
          }
        }
      } else if (status === 'REJECTED') {
        const closed = await infra.closePrForRequest({ request: row, reason: row.reviewNote || 'all keys rejected' });
        await persistInfraResult(requestId, closed);
      } else if (status === 'APPLY_FAILED') {
        const noted = await infra.notePrFailure({ request: row, error: row.applyError || 'apply failed' });
        await persistInfraResult(requestId, noted);
      }
    } catch (err: any) {
      logger.error('Failed to sync infra-deployment PR for secret ingestion review:', err.message);
      // Fallback: the AWS write already succeeded (this is the reviewed event), but mirroring
      // the approved keys into the deployment PR threw before it could record its own outcome
      // (openPrForRequest, or mergePrForRequest's pre-finalize content phase — only the finalize
      // phase returns FAILED without throwing). Without recording FAILED here the request keeps a
      // stale infraSyncState (null or OPEN) that never re-enters an admin queue and can't be
      // retried — so the key lives in AWS but is never registered in a manifest, invisibly, with
      // only this log line. Persist FAILED so it surfaces in the review queue for Retry/Dismiss.
      try {
        const { requestId, status } = (event.payload ?? {}) as any;
        if (requestId && (status === 'APPLIED' || status === 'PARTIALLY_APPLIED')) {
          await prisma.secretIngestionRequest.update({
            where: { id: requestId },
            data: {
              infraSyncState: 'FAILED',
              infraSyncNote: `Deployment PR sync failed: ${err.message}. Retry from the review queue once the cause is resolved.`,
            },
          });
        }
      } catch (persistErr: any) {
        logger.error('Also failed to record deployment PR FAILED state:', persistErr.message);
      }
    }
  });


  logger.info('📡 Event listeners registered.');
}
