import prisma from '../config/prisma';
import secretsManagerService, { SecretScopePattern } from './secrets-manager.service';
import eventBus from './event-bus';
import logger from '../utils/logger';
import { AuthenticatedUser } from '../middleware/auth.middleware';
import { getManageableGroupIds } from '../utils/authz';
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
  ConflictError,
} from '../utils/errors';

const PLATFORM = 'secrets';

export type IngestionDecision = 'APPROVED' | 'REJECTED';

export interface IngestionEntry {
  key: string;
  value: string | null;
  decision?: IngestionDecision | null;
  applied?: boolean;
  error?: string | null;
  /**
   * Live AWS value for this key at read time — attached only for the review-queue
   * listing (see listIngestionRequests), never persisted. null means the key doesn't
   * exist yet (this entry is an ADD, not an UPDATE); undefined means it couldn't be
   * determined (e.g. the secret's current payload isn't key-value JSON).
   */
  previousValue?: string | null;
}

export interface SecretTarget {
  groupId: string;
  groupName: string;
  secretName: string;
}

interface ScopedPattern {
  groupId: string;
  groupName: string;
  pattern: SecretScopePattern;
}

export class SecretIngestionService {
  /**
   * Resolves the raw scope patterns (exact names and/or wildcards) from a user's active
   * secrets-platform grants. No AWS call — wildcards are expanded lazily by the callers below.
   */
  async resolveUserScopePatterns(userId: string): Promise<ScopedPattern[]> {
    const grants = await prisma.userAccess.findMany({
      where: { userId, isActive: true, group: { platform: PLATFORM } },
      include: { group: true, level: true },
      orderBy: { grantedAt: 'desc' },
    });

    const out: ScopedPattern[] = [];
    for (const g of grants) {
      const externalGroupId = g.level?.externalGroupId ?? g.group.externalGroupId;
      if (!externalGroupId) {
        continue;
      }
      let patterns: SecretScopePattern[] = [];
      try {
        patterns = secretsManagerService.parseScopePatterns(externalGroupId);
      } catch {
        continue;
      }
      for (const pattern of patterns) {
        out.push({ groupId: g.groupId, groupName: g.group.name, pattern });
      }
    }
    return out;
  }

  /**
   * Resolves the concrete list of secret names covered by the user's grants. Exact-name
   * grants map to themselves; wildcard/prefix grants are expanded LIVE against AWS ListSecrets,
   * so newly-added secrets that match automatically appear without editing the group.
   */
  async resolveUserSecretTargets(userId: string): Promise<SecretTarget[]> {
    const scoped = await this.resolveUserScopePatterns(userId);
    const needsLive = scoped.some(s => s.pattern.kind !== 'exact');
    const allNames = needsLive ? await secretsManagerService.listAllAwsSecrets() : [];

    const out: SecretTarget[] = [];
    for (const s of scoped) {
      if (s.pattern.kind === 'exact') {
        out.push({ groupId: s.groupId, groupName: s.groupName, secretName: s.pattern.name });
        continue;
      }
      for (const name of allNames) {
        if (secretsManagerService.matchesPattern(s.pattern, name)) {
          out.push({ groupId: s.groupId, groupName: s.groupName, secretName: name });
        }
      }
    }
    return out;
  }

  /**
   * Resolves the owning group + canonical secret name for a secret the user references,
   * honoring both exact names AND wildcard/prefix scopes. Returns null if out of scope.
   *
   * Exact-name grants win first (deterministic; casing is canonicalized from the grant list,
   * since AWS names are case-sensitive). Otherwise a wildcard/prefix grant matches; casing is
   * taken from the live AWS list when the secret already exists, else the caller's input — a
   * prefix scope may legitimately create a brand-new secret in its namespace.
   */
  async resolveSecretForUser(userId: string, secretName: string): Promise<SecretTarget | null> {
    const wanted = secretName.trim();
    if (!wanted) {
      return null;
    }
    const scoped = await this.resolveUserScopePatterns(userId);

    const exact = scoped
      .filter(s => s.pattern.kind === 'exact' && s.pattern.name.toLowerCase() === wanted.toLowerCase())
      .sort((a, b) => a.groupId.localeCompare(b.groupId));
    if (exact.length > 0) {
      const m = exact[0];
      return {
        groupId: m.groupId,
        groupName: m.groupName,
        secretName: (m.pattern as { name: string }).name,
      };
    }

    const wildcard = scoped
      .filter(s => s.pattern.kind !== 'exact' && secretsManagerService.matchesPattern(s.pattern, wanted))
      .sort((a, b) => a.groupId.localeCompare(b.groupId));
    if (wildcard.length === 0) {
      return null;
    }

    // Canonicalize casing against the live list when the secret already exists.
    let canonical = wanted;
    const existing = (await secretsManagerService.listAllAwsSecrets()).find(
      n => n.toLowerCase() === wanted.toLowerCase(),
    );
    if (existing) {
      canonical = existing;
    }
    const m = wildcard[0];
    return { groupId: m.groupId, groupName: m.groupName, secretName: canonical };
  }

  /**
   * Prepares the UI-friendly list of authorized groups and secret names.
   */
  async getUserScope(userId: string) {
    const targets = await this.resolveUserSecretTargets(userId);
    const groups = new Map<string, { groupId: string; groupName: string; secretNames: Set<string> }>();
    
    for (const t of targets) {
      let group = groups.get(t.groupId);
      if (!group) {
        group = { groupId: t.groupId, groupName: t.groupName, secretNames: new Set() };
        groups.set(t.groupId, group);
      }
      group.secretNames.add(t.secretName);
    }

    return [...groups.values()].map(g => ({
      groupId: g.groupId,
      groupName: g.groupName,
      secretNames: [...g.secretNames],
    }));
  }

  /**
   * Checks scope and returns masked key list. Resolves to the CANONICAL casing stored in
   * the group's grant list — AWS secret names are case-sensitive, so looking up the
   * client-supplied casing directly could silently miss the real secret.
   */
  async listSecretKeys(userId: string, secretName: string): Promise<{ exists: boolean; keys: string[] }> {
    const match = await this.resolveSecretForUser(userId, secretName);
    if (!match) {
      throw new AuthorizationError(`You do not have access to secret "${secretName}".`);
    }
    return secretsManagerService.listSecretKeys(match.secretName);
  }

  /**
   * Stages a PENDING request with entries.
   */
  async createIngestionRequest(opts: {
    requester: AuthenticatedUser;
    secretName: string;
    entries: { key: string; value: string }[];
    justification?: string;
  }) {
    // Key/value shape (non-empty entries, length limits) is validated at the
    // controller boundary via submitIngestionSchema — this is the only caller.
    const { requester, entries, justification } = opts;

    const owner = await this.resolveSecretForUser(requester.id, opts.secretName);
    if (!owner) {
      throw new AuthorizationError(`You don't have permission to write to secret "${opts.secretName}".`);
    }
    // Canonicalize to the exact casing stored in the group's grant list — AWS secret
    // names are case-sensitive, so writing the client-supplied casing could create a
    // sibling secret instead of matching the one the group actually grants.
    const secretName = owner.secretName;

    const row = await prisma.secretIngestionRequest.create({
      data: {
        requesterId: requester.id,
        requesterName: requester.username,
        requesterEmail: requester.email,
        groupId: owner.groupId,
        secretName,
        status: 'PENDING',
        entries: entries.map(e => ({
          key: e.key.trim(),
          value: e.value,
          decision: null,
          applied: false,
        })) as any,
        justification: justification?.trim() || null,
      },
    });

    await prisma.auditEntry.create({
      data: {
        action: 'SECRET_INGESTION_SUBMITTED',
        performerId: requester.id,
        performerName: requester.username,
        groupId: owner.groupId,
        details: {
          requestId: row.id,
          secretName,
          keyCount: entries.length,
          justification: row.justification,
        } as any,
      },
    });

    eventBus.emitAccessEvent({
      type: 'secret-ingestion.submitted' as any,
      payload: {
        requestId: row.id,
        secretName,
        groupId: owner.groupId,
        groupName: owner.groupName,
        requesterName: requester.username,
        justification: row.justification,
        keyCount: entries.length,
      },
      timestamp: new Date(),
    });

    return row;
  }

  /**
   * Groups a platform admin/super admin/group admin has review rights over.
   */
  async reviewableGroupIds(user: AuthenticatedUser): Promise<{ all: boolean; groupIds: string[] }> {
    return getManageableGroupIds(user, PLATFORM);
  }

  /**
   * Lists personal requests, or requests awaiting review — PENDING plus retryable
   * APPLY_FAILED (a failed apply must re-surface in the review queue or it would be
   * stranded, reachable only from the requester's read-only "mine" list).
   */
  async listIngestionRequests(user: AuthenticatedUser, scope: 'mine' | 'review') {
    if (scope === 'mine') {
      return prisma.secretIngestionRequest.findMany({
        where: { requesterId: user.id },
        orderBy: { createdAt: 'desc' },
        // Cap the personal history — long-lived users accumulate rows forever.
        take: 200,
      });
    }
    const { all, groupIds } = await this.reviewableGroupIds(user);
    if (!all && groupIds.length === 0) {
      return [];
    }
    const rows = await prisma.secretIngestionRequest.findMany({
      where: {
        status: { in: ['PENDING', 'APPLY_FAILED'] },
        ...(all ? {} : { groupId: { in: groupIds } }),
      },
      orderBy: { createdAt: 'asc' },
    });
    return this.attachPreviousValues(rows);
  }

  /**
   * Annotates each entry with the key's CURRENT AWS value, so the approver sees a real
   * before/after diff instead of just the proposed value. Computed live (not persisted)
   * since the request may sit pending for a while — by the time it's reviewed, AWS may
   * have moved on. One getSecretMap call per distinct secret name in the queue.
   */
  private async attachPreviousValues<
    T extends { secretName: string; entries: unknown },
  >(rows: T[]): Promise<T[]> {
    const secretNames = [...new Set(rows.map(r => r.secretName))];
    const mapByName = new Map<string, Record<string, string> | null>();
    await Promise.all(
      secretNames.map(async name => {
        try {
          mapByName.set(name, await secretsManagerService.getSecretMap(name));
        } catch (err: any) {
          logger.warn(
            { secretName: name, error: err.message },
            'Could not resolve current value for secret ingestion diff',
          );
          mapByName.set(name, null);
        }
      }),
    );

    return rows.map(row => {
      const currentMap = mapByName.get(row.secretName);
      const entries = ((row.entries as unknown as IngestionEntry[]) ?? []).map(
        e => ({
          ...e,
          previousValue: currentMap ? currentMap[e.key] ?? null : undefined,
        }),
      );
      return { ...row, entries } as T;
    });
  }

  async getById(id: string) {
    return prisma.secretIngestionRequest.findUnique({ where: { id } });
  }

  /**
   * Can a user review this request.
   */
  async canReview(user: AuthenticatedUser, request: { groupId: string | null }): Promise<boolean> {
    const { all, groupIds } = await this.reviewableGroupIds(user);
    if (all) {
      return true;
    }
    if (!request.groupId) {
      return false;
    }
    return groupIds.includes(request.groupId);
  }

  /**
   * Applies approved key-value entries to the secret. Values are redacted in Postgres once
   * the request reaches a genuinely terminal outcome (APPLIED/PARTIALLY_APPLIED/REJECTED).
   * APPLY_FAILED is retryable — re-review is allowed from that status too, and values are
   * kept until a retry actually succeeds/terminates, so a transient AWS error (throttling,
   * a network blip) can't strand the request with no way to recover the entered values.
   */
  async reviewIngestionRequest(
    requestId: string,
    reviewer: { id: string; username: string },
    decisions: { key: string; decision: IngestionDecision }[],
    note?: string,
  ) {
    const row = await prisma.secretIngestionRequest.findUnique({
      where: { id: requestId },
    });
    if (!row) {
      throw new NotFoundError('Secret Ingestion Request not found');
    }
    if (row.status !== 'PENDING' && row.status !== 'APPLY_FAILED') {
      throw new ValidationError(`Request is not pending or retryable (status: ${row.status}).`);
    }

    const claim = await prisma.secretIngestionRequest.updateMany({
      where: { id: requestId, status: { in: ['PENDING', 'APPLY_FAILED'] } },
      data: {
        status: 'APPLYING',
        reviewerId: reviewer.id,
        reviewerName: reviewer.username,
        reviewNote: note ?? null,
        reviewedAt: new Date(),
      },
    });
    if (claim.count === 0) {
      throw new ConflictError('This request is already being reviewed or applied by another admin.');
    }

    const decisionByKey = new Map(decisions.map(d => [d.key, d.decision]));
    const entries = ((row.entries as unknown as IngestionEntry[]) ?? []).map(e => ({
      ...e,
    }));

    const approvedKv: Record<string, string> = {};
    let approvedCount = 0;
    let rejectedCount = 0;

    for (const e of entries) {
      e.decision = decisionByKey.get(e.key) === 'APPROVED' ? 'APPROVED' : 'REJECTED';
      if (e.decision === 'APPROVED') {
        approvedCount++;
        approvedKv[e.key] = e.value || '';
      } else {
        rejectedCount++;
      }
    }

    let failedCount = 0;
    let applyError: string | null = null;

    if (approvedCount > 0) {
      try {
        await secretsManagerService.putSecretKeyValues(row.secretName, approvedKv, {
          createIfMissing: true,
        });
        for (const e of entries) {
          if (e.decision === 'APPROVED') {
            e.applied = true;
            e.error = null;
          }
        }
      } catch (err: any) {
        failedCount = approvedCount;
        applyError = err.message;
        for (const e of entries) {
          if (e.decision === 'APPROVED') {
            e.applied = false;
            e.error = err.message;
          }
        }
        logger.error(
          { requestId, secretName: row.secretName, error: err.message },
          'Failed to apply secret ingestion request',
        );
      }
    }

    let status: 'APPLIED' | 'PARTIALLY_APPLIED' | 'APPLY_FAILED' | 'REJECTED';
    if (failedCount > 0) {
      status = 'APPLY_FAILED';
    } else if (approvedCount === 0) {
      status = 'REJECTED';
    } else if (rejectedCount === 0) {
      status = 'APPLIED';
    } else {
      status = 'PARTIALLY_APPLIED';
    }

    // Redact values only once the request is genuinely terminal. APPLY_FAILED stays
    // retryable, so keep the values around for the next review attempt — redacting here
    // would strand the request with no way to recover the entered values.
    const finalEntries =
      status === 'APPLY_FAILED' ? entries : entries.map(e => ({ ...e, value: null }));

    const updated = await prisma.secretIngestionRequest.update({
      where: { id: row.id },
      data: {
        status,
        entries: finalEntries as any,
        // A fully-rejected request never touched AWS — don't stamp an apply time.
        appliedAt: status === 'REJECTED' ? null : new Date(),
        applyError,
      },
    });

    await prisma.auditEntry.create({
      data: {
        action: `SECRET_INGESTION_${status}`,
        performerId: reviewer.id,
        performerName: reviewer.username,
        groupId: row.groupId,
        details: {
          requestId: row.id,
          secretName: row.secretName,
          approvedCount,
          rejectedCount,
          failedCount,
          applyError,
        } as any,
      },
    });

    eventBus.emitAccessEvent({
      type: 'secret-ingestion.reviewed' as any,
      payload: {
        requestId: row.id,
        secretName: row.secretName,
        status,
        reviewerName: reviewer.username,
        approvedCount,
        rejectedCount,
        failedCount,
      },
      timestamp: new Date(),
    });

    return updated;
  }

  /**
   * Recovers requests orphaned in APPLYING state.
   */
  async sweepStuckApplying(maxAgeMs: number = 10 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const result = await prisma.secretIngestionRequest.updateMany({
      where: { status: 'APPLYING', updatedAt: { lt: cutoff } },
      data: {
        status: 'APPLY_FAILED',
        applyError:
          'Apply did not complete (process interrupted); recovered by sweep — re-review to retry.',
      },
    });
    if (result.count > 0) {
      logger.warn(
        { count: result.count },
        'Recovered Secret Ingestion requests stuck in APPLYING',
      );
    }
    return result.count;
  }
}

export const secretIngestionService = new SecretIngestionService();
export default secretIngestionService;
