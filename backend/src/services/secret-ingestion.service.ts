import prisma from '../config/prisma';
import {
  SecretScopePattern,
  getSecretsManagerService,
} from './secrets-manager.service';
import {
  InfraSyncResult,
  SelectedTarget,
  getInfraRepoSyncService,
  isInfraRepoEnabled,
  isInfraAutoMergeEnabled,
} from './infra-repo-sync.service';
import eventBus from './event-bus';
import config from '../config/config';
import logger from '../utils/logger';
import { encrypt, decrypt } from '../utils/crypto';
import { AuthenticatedUser } from '../middleware/auth.middleware';
import { getManageableGroupIds } from '../utils/authz';
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
  ConflictError,
} from '../utils/errors';

/** Default / prod Secret Ingestion instance key. Callers that omit `platform` target this. */
const PLATFORM = 'secrets';

/** Enabled Secret Ingestion instance keys (prod + any configured sandbox), from config. */
export function secretsFamilyPlatforms(): string[] {
  return config.secretsInstances.filter(i => i.enabled).map(i => i.key);
}

/**
 * Whether `platform` belongs to the Secret Ingestion ('secrets') family — checked against ALL
 * configured instances, not just enabled ones, so this stays true even for a since-disabled
 * sandbox. Used to gate `openEnrollment`: that field only makes sense for secrets groups (it's
 * what lets every user implicitly stage ingestion requests) — any other platform's groups still
 * require the normal request/approve/provision flow, so open enrollment there would show a
 * group as ACTIVE for every user with no actual grant or provisioning behind it.
 */
export function isSecretsFamilyPlatform(platform: string): boolean {
  const key = (platform || '').toLowerCase();
  return config.secretsInstances.some(
    i => i.family === 'secrets' && i.key === key,
  );
}

/** Guard: reject a platform that isn't a configured Secret Ingestion instance. */
export function assertSecretsPlatform(platform: string): string {
  const key = (platform || '').toLowerCase();
  if (!secretsFamilyPlatforms().includes(key)) {
    throw new ValidationError(
      `"${platform}" is not a configured Secret Ingestion instance.`,
    );
  }
  return key;
}

/**
 * Persist the outcome of an infra-deployment PR operation onto the ingestion request. Shared
 * by the async review-time listener (event-listeners.ts) and the manual retry path below, so
 * the field-presence nuance below has one home instead of drifting between two copies.
 */
export async function persistInfraResult(
  requestId: string,
  r: InfraSyncResult,
): Promise<void> {
  await prisma.secretIngestionRequest.update({
    where: { id: requestId },
    data: {
      // A field is only included in `data` when the result object actually specifies the
      // key — `'prNumber' in r` distinguishes an explicit `null` (clear the column) from an
      // omitted key (leave the column unchanged), which a plain `?? undefined` could not: it
      // silently collapsed both to "unchanged", so a result that legitimately needs to clear
      // a stale infraPrNumber/infraBranch would find it never actually clears.
      ...('prNumber' in r ? { infraPrNumber: r.prNumber } : {}),
      ...('prUrl' in r ? { infraPrUrl: r.prUrl } : {}),
      ...('prNodeId' in r ? { infraPrNodeId: r.prNodeId } : {}),
      ...('branch' in r ? { infraBranch: r.branch } : {}),
      infraSyncState: r.state,
      infraSyncNote: r.note ?? null,
    },
  });
}

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
  private decryptRow<T extends { entries: unknown }>(row: T): T {
    if (!row) return row;
    const entries = ((row.entries as unknown as IngestionEntry[]) ?? []).map(
      e => ({
        ...e,
        value: decrypt(e.value) ?? null,
      })
    );
    return { ...row, entries: entries as any };
  }

  private decryptRows<T extends { entries: unknown }>(rows: T[]): T[] {
    return rows.map(r => this.decryptRow(r));
  }

  private encryptEntries(entries: IngestionEntry[]): IngestionEntry[] {
    return entries.map(e => ({
      ...e,
      value: encrypt(e.value) ?? null,
    }));
  }

  /**
   * Resolves the raw scope patterns (exact names and/or wildcards) from a user's active
   * secrets-platform grants. No AWS call — wildcards are expanded lazily by the callers below.
   */
  async resolveUserScopePatterns(
    userId: string,
    platform: string = PLATFORM,
  ): Promise<ScopedPattern[]> {
    const svc = getSecretsManagerService(platform);
    const grants = await prisma.userAccess.findMany({
      where: { userId, isActive: true, group: { platform } },
      include: { group: true, level: true },
      orderBy: { grantedAt: 'desc' },
    });

    const out: ScopedPattern[] = [];
    const seenGroupIds = new Set<string>();
    for (const g of grants) {
      const externalGroupId =
        g.level?.externalGroupId ?? g.group.externalGroupId;
      if (!externalGroupId) {
        continue;
      }
      let patterns: SecretScopePattern[] = [];
      try {
        patterns = svc.parseScopePatterns(externalGroupId);
      } catch {
        continue;
      }
      seenGroupIds.add(g.groupId);
      for (const pattern of patterns) {
        out.push({ groupId: g.groupId, groupName: g.group.name, pattern });
      }
    }

    // Open-enrollment secrets groups are implicitly granted to EVERY authenticated
    // user — no UserAccess row exists, so add their scope here regardless of who the
    // caller is. This is what lets all users request Secret Ingestion with no join
    // step, while group admins still gate the ingestion requests. Deduped against the
    // groups the user already holds an explicit grant on (a user could be both).
    const openGroups = await prisma.group.findMany({
      where: {
        platform,
        isActive: true,
        openEnrollment: true,
        externalGroupId: { not: null },
      },
      select: { id: true, name: true, externalGroupId: true },
    });
    for (const g of openGroups) {
      if (seenGroupIds.has(g.id) || !g.externalGroupId) {
        continue;
      }
      let patterns: SecretScopePattern[] = [];
      try {
        patterns = svc.parseScopePatterns(g.externalGroupId);
      } catch {
        continue;
      }
      seenGroupIds.add(g.id);
      for (const pattern of patterns) {
        out.push({ groupId: g.id, groupName: g.name, pattern });
      }
    }
    return out;
  }

  /**
   * Resolves the concrete list of secret names covered by the user's grants. Exact-name
   * grants map to themselves; wildcard/prefix grants are expanded LIVE against AWS ListSecrets,
   * so newly-added secrets that match automatically appear without editing the group.
   */
  async resolveUserSecretTargets(
    userId: string,
    platform: string = PLATFORM,
  ): Promise<SecretTarget[]> {
    const svc = getSecretsManagerService(platform);
    const scoped = await this.resolveUserScopePatterns(userId, platform);
    const needsLive = scoped.some(s => s.pattern.kind !== 'exact');
    const allNames = needsLive ? await svc.listAllAwsSecrets() : [];

    const out: SecretTarget[] = [];
    for (const s of scoped) {
      if (s.pattern.kind === 'exact') {
        out.push({
          groupId: s.groupId,
          groupName: s.groupName,
          secretName: s.pattern.name,
        });
        continue;
      }
      for (const name of allNames) {
        if (svc.matchesPattern(s.pattern, name)) {
          out.push({
            groupId: s.groupId,
            groupName: s.groupName,
            secretName: name,
          });
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
  async resolveSecretForUser(
    userId: string,
    secretName: string,
    platform: string = PLATFORM,
  ): Promise<SecretTarget | null> {
    const svc = getSecretsManagerService(platform);
    const wanted = secretName.trim();
    if (!wanted) {
      return null;
    }
    const scoped = await this.resolveUserScopePatterns(userId, platform);

    const exact = scoped
      .filter(
        s =>
          s.pattern.kind === 'exact' &&
          s.pattern.name.toLowerCase() === wanted.toLowerCase(),
      )
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
      .filter(
        s =>
          s.pattern.kind !== 'exact' && svc.matchesPattern(s.pattern, wanted),
      )
      .sort((a, b) => a.groupId.localeCompare(b.groupId));
    if (wildcard.length === 0) {
      return null;
    }

    // Canonicalize casing against the live list when the secret already exists.
    let canonical = wanted;
    const existing = (await svc.listAllAwsSecrets()).find(
      n => n.toLowerCase() === wanted.toLowerCase(),
    );
    if (existing) {
      canonical = existing;
    }
    const m = wildcard[0];
    return {
      groupId: m.groupId,
      groupName: m.groupName,
      secretName: canonical,
    };
  }

  /**
   * Prepares the UI-friendly list of authorized groups and secret names.
   */
  async getUserScope(userId: string, platform: string = PLATFORM) {
    const targets = await this.resolveUserSecretTargets(userId, platform);
    const groups = new Map<
      string,
      { groupId: string; groupName: string; secretNames: Set<string> }
    >();

    for (const t of targets) {
      let group = groups.get(t.groupId);
      if (!group) {
        group = {
          groupId: t.groupId,
          groupName: t.groupName,
          secretNames: new Set(),
        };
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
  async listSecretKeys(
    userId: string,
    secretName: string,
    platform: string = PLATFORM,
  ): Promise<{ exists: boolean; keys: string[] }> {
    const match = await this.resolveSecretForUser(userId, secretName, platform);
    if (!match) {
      throw new AuthorizationError(
        `You do not have access to secret "${secretName}".`,
      );
    }
    return getSecretsManagerService(platform).listSecretKeys(match.secretName);
  }

  /**
   * Preview which infra-deployment manifests a request would edit — the compose screen
   * shows this so the requester can review/adjust before submitting. Scope-checked exactly
   * like a submit (you can only preview a secret you're allowed to write to).
   */
  async previewInfraTargets(
    userId: string,
    secretName: string,
    keys: string[],
    platform: string = PLATFORM,
  ) {
    const owner = await this.resolveSecretForUser(userId, secretName, platform);
    if (!owner) {
      throw new AuthorizationError(
        `You don't have permission to write to secret "${secretName}".`,
      );
    }
    // An instance whose infra-deployment repo isn't wired (the sandbox, until its repo is added)
    // mirrors nothing — no manifest targets to preview.
    if (!isInfraRepoEnabled(platform)) {
      return { secretName: owner.secretName, targets: [] };
    }
    // The secret's current keys let the (simulated) resolver mark already-present keys as
    // "no change". In live mode the resolver diffs the real manifest and ignores this.
    let existingKeys: string[] = [];
    try {
      existingKeys = (
        await getSecretsManagerService(platform).listSecretKeys(
          owner.secretName,
        )
      ).keys;
    } catch {
      existingKeys = [];
    }
    const targets = await getInfraRepoSyncService(platform).resolveTargets(
      owner.secretName,
      keys,
      existingKeys,
    );
    return { secretName: owner.secretName, targets };
  }

  /**
   * Stages a PENDING request with entries.
   */
  async createIngestionRequest(opts: {
    requester: AuthenticatedUser;
    secretName: string;
    entries: { key: string; value: string }[];
    justification?: string;
    infraTargets?: SelectedTarget[];
    platform?: string;
  }) {
    // Key/value shape (non-empty entries, length limits) is validated at the
    // controller boundary via submitIngestionSchema — this is the only caller.
    const { requester, entries, justification } = opts;
    const platform = assertSecretsPlatform(opts.platform ?? PLATFORM);

    const owner = await this.resolveSecretForUser(
      requester.id,
      opts.secretName,
      platform,
    );
    if (!owner) {
      throw new AuthorizationError(
        `You don't have permission to write to secret "${opts.secretName}".`,
      );
    }
    // Canonicalize to the exact casing stored in the group's grant list — AWS secret
    // names are case-sensitive, so writing the client-supplied casing could create a
    // sibling secret instead of matching the one the group actually grants.
    const secretName = owner.secretName;

    // The requester's chosen manifest files (from the compose preview). An explicit empty
    // array is preserved (it means "no files → no PR", e.g. an update-only request) and is
    // honored verbatim; null means the requester never saw the preview, so the PR falls back
    // to the live auto-resolved consumer set. An instance whose infra repo isn't wired (sandbox,
    // until configured) never opens a PR, so any targets are dropped up front.
    const infraTargets =
      isInfraRepoEnabled(platform) && opts.infraTargets
        ? opts.infraTargets.map(t => ({
            path: t.path.trim(),
            manifestRef: t.manifestRef?.trim() || secretName,
            format: t.format,
            keys:
              t.keys && t.keys.length > 0
                ? [...new Set(t.keys.map(k => k.trim()).filter(Boolean))]
                : undefined,
            env: t.env?.trim() || undefined,
          }))
        : null;

    const row = await prisma.secretIngestionRequest.create({
      data: {
        requesterId: requester.id,
        requesterName: requester.username,
        requesterEmail: requester.email,
        groupId: owner.groupId,
        platform,
        secretName,
        status: 'PENDING',
        entries: entries.map(e => ({
          key: e.key.trim(),
          value: encrypt(e.value) ?? null,
          decision: null,
          applied: false,
        })) as any,
        justification: justification?.trim() || null,
        infraTargets: infraTargets as any,
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
          keys: entries.map(e => e.key.trim()),
          justification: row.justification,
        } as any,
      },
    });

    eventBus.emitAccessEvent({
      type: 'secret-ingestion.submitted' as any,
      payload: {
        requestId: row.id,
        platform,
        secretName,
        groupId: owner.groupId,
        groupName: owner.groupName,
        requesterName: requester.username,
        justification: row.justification,
        keyCount: entries.length,
      },
      timestamp: new Date(),
    });

    return this.decryptRow(row);
  }

  /**
   * Groups a platform admin/super admin/group admin has review rights over.
   */
  async reviewableGroupIds(
    user: AuthenticatedUser,
    platform: string = PLATFORM,
  ): Promise<{ all: boolean; groupIds: string[] }> {
    return getManageableGroupIds(user, platform);
  }

  /**
   * Lists personal requests, or requests awaiting review — PENDING plus retryable
   * APPLY_FAILED (a failed apply must re-surface in the review queue or it would be
   * stranded, reachable only from the requester's read-only "mine" list).
   *
   * `platform` scopes to one Secret Ingestion instance; omitted, it spans the whole
   * secrets family (prod + sandbox) — the reviewer's inbox merges both, each row still
   * carrying its own `platform` so the UI can badge it and the apply path hits the
   * right AWS account.
   */
  async listIngestionRequests(
    user: AuthenticatedUser,
    scope: 'mine' | 'review',
    platform?: string,
  ) {
    if (scope === 'mine') {
      // Unlike 'review' below, this is not scoped to what's currently actionable — it's a
      // read of the caller's OWN history. If an instance is later disabled after having been
      // used (e.g. secrets-sandbox env vars unset post-go-live), secretsFamilyPlatforms()
      // would exclude it and silently hide the user's own past requests from that instance,
      // even though the rows still exist. List against every KNOWN instance key (enabled or
      // not) when no explicit platform is given, so historical rows never disappear. An
      // explicit platform filter must honor the same intent — validate against every
      // configured instance (not assertSecretsPlatform's enabled-only list), so filtering
      // "mine" by a since-disabled instance still returns the caller's own history instead
      // of 400ing.
      let platforms: string[];
      if (platform) {
        if (!isSecretsFamilyPlatform(platform)) {
          throw new ValidationError(
            `"${platform}" is not a configured Secret Ingestion instance.`,
          );
        }
        platforms = [platform.toLowerCase()];
      } else {
        platforms = config.secretsInstances.map(i => i.key);
      }
      const rows = await prisma.secretIngestionRequest.findMany({
        where: { requesterId: user.id, platform: { in: platforms } },
        orderBy: { createdAt: 'desc' },
        // Cap the personal history — long-lived users accumulate rows forever.
        take: 200,
      });
      return this.decryptRows(rows);
    }
    // Review queue: only currently-enabled instances are actionable, so this intentionally
    // stays scoped to secretsFamilyPlatforms() (enabled-only) — reviewing a disabled instance's
    // requests wouldn't be able to apply anything against it anyway.
    const platforms = platform
      ? [assertSecretsPlatform(platform)]
      : secretsFamilyPlatforms();
    // Review queue: a request from instance P is visible when the reviewer is a super/platform
    // admin for P (all) or a group admin of the request's group on P. Build a per-instance OR
    // so a `secrets` platform admin never sees `secrets-sandbox` requests (and vice versa).
    const perPlatform = await Promise.all(
      platforms.map(async p => ({
        platform: p,
        ...(await this.reviewableGroupIds(user, p)),
      })),
    );
    const orClauses = perPlatform
      .map(m => {
        if (m.all) {
          return { platform: m.platform };
        }
        if (m.groupIds.length > 0) {
          return { platform: m.platform, groupId: { in: m.groupIds } };
        }
        return null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
    if (orClauses.length === 0) {
      return [];
    }
    const rows = await prisma.secretIngestionRequest.findMany({
      where: {
        AND: [
          { OR: orClauses },
          {
            // Normally "actionable" means still PENDING/retryable APPLY_FAILED. But a request
            // whose AWS write already succeeded (APPLIED/PARTIALLY_APPLIED — terminal, can't be
            // re-reviewed) can still have infraSyncState FAILED (e.g. GitHub branch protection
            // blocked the auto-merge, 405) — that's a stuck deployment PR with no other way back
            // into an admin's queue, so surface it here too so "Retry merge" has somewhere to live.
            OR: [
              {
                status: {
                  in: ['PENDING', 'APPLY_FAILED'] as (
                    | 'PENDING'
                    | 'APPLY_FAILED'
                  )[],
                },
              },
              { infraSyncState: 'FAILED' },
            ],
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    const decrypted = this.decryptRows(rows);
    return this.attachPreviousValues(decrypted);
  }

  /**
   * Annotates each entry with the key's CURRENT AWS value, so the approver sees a real
   * before/after diff instead of just the proposed value. Computed live (not persisted)
   * since the request may sit pending for a while — by the time it's reviewed, AWS may
   * have moved on. One getSecretMap call per distinct secret name in the queue.
   */
  private async attachPreviousValues<
    T extends { platform: string; secretName: string; entries: unknown },
  >(rows: T[]): Promise<T[]> {
    // Key by (platform, secretName): two instances may hold a secret of the same name in
    // different AWS accounts, so each must be read from its own SecretsManagerService.
    const keyOf = (r: { platform: string; secretName: string }) =>
      `${r.platform} ${r.secretName}`;
    const mapByKey = new Map<string, Record<string, string> | null>();
    const distinct = [...new Map(rows.map(r => [keyOf(r), r])).values()];
    await Promise.all(
      distinct.map(async r => {
        try {
          mapByKey.set(
            keyOf(r),
            await getSecretsManagerService(r.platform).getSecretMap(
              r.secretName,
            ),
          );
        } catch (err: any) {
          logger.warn(
            {
              platform: r.platform,
              secretName: r.secretName,
              error: err.message,
            },
            'Could not resolve current value for secret ingestion diff',
          );
          mapByKey.set(keyOf(r), null);
        }
      }),
    );

    return rows.map(row => {
      const currentMap = mapByKey.get(keyOf(row));
      const entries = ((row.entries as unknown as IngestionEntry[]) ?? []).map(
        e => ({
          ...e,
          previousValue: currentMap ? (currentMap[e.key] ?? null) : undefined,
        }),
      );
      return { ...row, entries } as T;
    });
  }

  async getById(id: string) {
    const row = await prisma.secretIngestionRequest.findUnique({ where: { id } });
    return row ? this.decryptRow(row) : null;
  }

  /**
   * Can a user review this request.
   */
  async canReview(
    user: AuthenticatedUser,
    request: { groupId: string | null; platform?: string | null },
  ): Promise<boolean> {
    const { all, groupIds } = await this.reviewableGroupIds(
      user,
      request.platform ?? PLATFORM,
    );
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
    const decryptedRow = this.decryptRow(row);
    if (decryptedRow.status !== 'PENDING' && decryptedRow.status !== 'APPLY_FAILED') {
      throw new ValidationError(
        `Request is not pending or retryable (status: ${decryptedRow.status}).`,
      );
    }

    // Resolve the AWS account this request targets from the row itself, so the read/apply
    // below hit the correct instance (prod vs sandbox) regardless of the caller.
    const svc = getSecretsManagerService(decryptedRow.platform);

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
      throw new ConflictError(
        'This request is already being reviewed or applied by another admin.',
      );
    }

    const decisionByKey = new Map(decisions.map(d => [d.key, d.decision]));
    const entries = ((decryptedRow.entries as unknown as IngestionEntry[]) ?? []).map(
      e => ({
        ...e,
      }),
    );

    // Snapshot which keys already exist in AWS BEFORE the write below — this is the only
    // point that can distinguish a genuinely NEW key (needs an infra-deployment PR) from a
    // value UPDATE (doesn't), since once putSecretKeyValues runs every approved key exists.
    // `previousValue` on entries is deliberately never persisted (see IngestionEntry) — it's
    // computed live for display only — so this can't be recomputed later from the DB row.
    let currentMap: Record<string, string> | null = null;
    try {
      currentMap = await svc.getSecretMap(decryptedRow.secretName);
    } catch {
      currentMap = null;
    }

    const approvedKv: Record<string, string> = {};
    let approvedCount = 0;
    let rejectedCount = 0;

    for (const e of entries) {
      e.decision =
        decisionByKey.get(e.key) === 'APPROVED' ? 'APPROVED' : 'REJECTED';
      if (e.decision === 'APPROVED') {
        approvedCount++;
        approvedKv[e.key] = e.value || '';
      } else {
        rejectedCount++;
      }
    }

    // Approved keys with no existing AWS value — the ones an infra-deployment PR is
    // actually for. Unknown (currentMap null, e.g. a non-JSON secret) errs toward "new" so
    // a needed PR is never silently skipped.
    const newApprovedKeys = entries
      .filter(
        e =>
          e.decision === 'APPROVED' &&
          (!currentMap || currentMap[e.key] === undefined),
      )
      .map(e => e.key);

    let failedCount = 0;
    let applyError: string | null = null;

    if (approvedCount > 0) {
      try {
        await svc.putSecretKeyValues(row.secretName, approvedKv, {
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
          { requestId, secretName: decryptedRow.secretName, error: err.message },
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
      status === 'APPLY_FAILED'
        ? this.encryptEntries(entries)
        : entries.map(e => ({ ...e, value: null }));

    const updated = await prisma.secretIngestionRequest.update({
      where: { id: decryptedRow.id },
      data: {
        status,
        entries: finalEntries as any,
        // A fully-rejected request never touched AWS — don't stamp an apply time.
        appliedAt: status === 'REJECTED' ? null : new Date(),
        applyError,
      },
    });

    // Record the actual key names touched, not just counts, so the audit trail shows
    // *which* keys changed. `appliedKeys` are the ones genuinely written to AWS
    // (empty on APPLY_FAILED, where they were approved but the write threw).
    const approvedKeys = entries
      .filter(e => e.decision === 'APPROVED')
      .map(e => e.key);
    const rejectedKeys = entries
      .filter(e => e.decision === 'REJECTED')
      .map(e => e.key);
    const appliedKeys = entries.filter(e => e.applied).map(e => e.key);

    await prisma.auditEntry.create({
      data: {
        action: `SECRET_INGESTION_${status}`,
        performerId: reviewer.id,
        performerName: reviewer.username,
        groupId: decryptedRow.groupId,
        details: {
          requestId: decryptedRow.id,
          secretName: decryptedRow.secretName,
          requesterName: decryptedRow.requesterName,
          reviewerName: reviewer.username,
          approvedCount,
          rejectedCount,
          failedCount,
          approvedKeys,
          rejectedKeys,
          appliedKeys,
          applyError,
        } as any,
      },
    });

    eventBus.emitAccessEvent({
      type: 'secret-ingestion.reviewed' as any,
      payload: {
        requestId: decryptedRow.id,
        platform: decryptedRow.platform,
        secretName: decryptedRow.secretName,
        status,
        reviewerName: reviewer.username,
        approvedCount,
        rejectedCount,
        failedCount,
        newApprovedKeys,
      },
      timestamp: new Date(),
    });

    return this.decryptRow(updated);
  }

  /**
   * Retries the infra-deployment PR sync for a request whose AWS write already succeeded
   * (status APPLIED/PARTIALLY_APPLIED — terminal, no longer re-reviewable) but whose PR sync
   * failed, e.g. GitHub branch protection blocking a bot-authored merge (405). Re-invokes the
   * same merge (or, with auto-merge off, the same recompute + ready-for-review) — useful once a
   * human has unblocked the underlying cause (bypassed/adjusted the protection rule, satisfied
   * a required check, etc.). Only meaningful when infraSyncState is FAILED.
   */
  async retryInfraMerge(requestId: string) {
    const row = await prisma.secretIngestionRequest.findUnique({
      where: { id: requestId },
    });
    if (!row) {
      throw new NotFoundError('Secret Ingestion Request not found');
    }
    const decryptedRow = this.decryptRow(row);
    if (decryptedRow.infraSyncState !== 'FAILED') {
      throw new ValidationError(
        `Nothing to retry — deployment PR sync state is "${decryptedRow.infraSyncState ?? 'none'}", not FAILED.`,
      );
    }
    if (!isInfraRepoEnabled(decryptedRow.platform)) {
      throw new ValidationError(
        `Deployment PR sync is not enabled for platform "${decryptedRow.platform}".`,
      );
    }

    const entries = (decryptedRow.entries as unknown as IngestionEntry[]) ?? [];
    const approvedKeys = entries
      .filter(e => e.decision === 'APPROVED')
      .map(e => e.key)
      .filter(Boolean);
    const review = {
      rejectedKeys: entries
        .filter(e => e.decision === 'REJECTED')
        .map(e => e.key)
        .filter(Boolean),
      requesterName: decryptedRow.requesterName ?? undefined,
      requesterEmail: decryptedRow.requesterEmail ?? undefined,
      reviewerName: decryptedRow.reviewerName ?? undefined,
    };
    const targets = (decryptedRow.infraTargets as SelectedTarget[] | null) || undefined;

    const infra = getInfraRepoSyncService(row.platform);

    // If a PR is already merged or closed on GitHub, resolve the sync state immediately to avoid
    // failing during branch recomputation/reset.
    if (row.infraPrNumber) {
      const liveState = await infra.getPrState(row.infraPrNumber);
      if (liveState === 'MERGED' || liveState === 'CLOSED') {
        await prisma.secretIngestionRequest.update({
          where: { id: requestId },
          data: {
            infraSyncState: liveState,
            infraSyncNote: `Sync state resolved to ${liveState.toLowerCase()} because PR was already ${liveState.toLowerCase()} on GitHub`,
          },
        });
        const res = await prisma.secretIngestionRequest.findUnique({
          where: { id: requestId },
        });
        return res ? this.decryptRow(res) : null;
      }
    }

    // A FAILED sync where no PR was ever recorded means the ORIGINAL open threw (not just the
    // merge) — e.g. GitHub was unreachable when the request was approved. Re-open the PR here so
    // Retry is a complete recovery path, not merely a merge-retry. openPrForRequest diffs the live
    // manifest and adds only genuinely-missing keys, so passing the full approved set is safe (an
    // already-registered key just yields SKIPPED). Mirrors the reviewed-event listener's re-open.
    let req = row;
    if (!row.infraPrNumber || !row.infraBranch) {
      const opened = await infra.openPrForRequest({
        requestId: row.id,
        secretName: row.secretName,
        proposedKeys: approvedKeys,
        targets,
        requesterName: row.requesterName,
        requesterEmail: row.requesterEmail,
      });
      await persistInfraResult(requestId, opened);
      // Nothing to merge (no consumers, keys already present, or open failed again) — the
      // persisted state above already reflects the outcome, so stop here.
      if (opened.state !== 'OPEN') {
        const res = await prisma.secretIngestionRequest.findUnique({
          where: { id: requestId },
        });
        return res ? this.decryptRow(res) : null;
      }
      req = {
        ...row,
        infraPrNumber: opened.prNumber ?? null,
        infraBranch: opened.branch ?? null,
        infraPrNodeId: opened.prNodeId ?? null,
      };
    }

    // Same split as the reviewed-event listener: auto-merge ON merges, OFF recomputes the
    // branch to the approved keys and marks it ready for a human to merge. The recompute is
    // not optional on the manual path — the branch still holds every key from submit time.
    const synced = (await isInfraAutoMergeEnabled(row.platform))
      ? await infra.mergePrForRequest({
          request: req,
          approvedKeys,
          targets,
          review,
        })
      : await infra.readyPrForRequest({
          request: req,
          approvedKeys,
          targets,
          review,
        });
    await persistInfraResult(requestId, synced);
    const res = await prisma.secretIngestionRequest.findUnique({
      where: { id: requestId },
    });
    return res ? this.decryptRow(res) : null;
  }

  /**
   * Dismisses a stuck deployment PR merge (infraSyncState FAILED — e.g. after a merge failure
   * has been manually resolved or is obsolete). Updates database state to CLOSED and attempts
   * to close the corresponding Pull Request on GitHub.
   */
  async dismissInfraMerge(requestId: string) {
    const row = await prisma.secretIngestionRequest.findUnique({
      where: { id: requestId },
    });
    if (!row) {
      throw new NotFoundError('Secret Ingestion Request not found');
    }
    if (row.infraSyncState !== 'FAILED') {
      throw new ValidationError(
        `Nothing to dismiss — deployment PR sync state is "${row.infraSyncState ?? 'none'}", not FAILED.`,
      );
    }

    if (row.infraPrNumber && isInfraRepoEnabled(row.platform)) {
      try {
        await getInfraRepoSyncService(row.platform).closePrForRequest({
          request: { infraPrNumber: row.infraPrNumber },
          reason:
            'Hermes: deployment PR dismissed by admin (marked resolved manually or obsolete).',
        });
      } catch (err: any) {
        logger.warn(
          { requestId, err: err.message },
          'Failed to close PR on GitHub during dismiss',
        );
      }
    }

    const updated = await prisma.secretIngestionRequest.update({
      where: { id: requestId },
      data: {
        infraSyncState: 'CLOSED',
        infraSyncNote:
          'Dismissed by admin (marked resolved manually or obsolete)',
      },
    });

    return this.decryptRow(updated);
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

  /**
   * Syncs the status of open infra-deployment PRs on GitHub with the database.
   * Finds all requests with status APPLIED or PARTIALLY_APPLIED that are still marked
   * as OPEN in infraSyncState, checks their state on GitHub, and updates the database.
   */
  async syncOpenDeploymentPRs(): Promise<number> {
    const openRequests = await prisma.secretIngestionRequest.findMany({
      where: {
        status: { in: ['APPLIED', 'PARTIALLY_APPLIED'] },
        infraSyncState: { in: ['OPEN', 'FAILED'] },
        infraPrNumber: { not: null },
      },
    });

    let updatedCount = 0;
    for (const row of openRequests) {
      if (!isInfraRepoEnabled(row.platform)) {continue;}
      const infra = getInfraRepoSyncService(row.platform);
      if (!row.infraPrNumber) {continue;}

      const state = await infra.getPrState(row.infraPrNumber);
      if (state && state !== 'OPEN') {
        await prisma.secretIngestionRequest.update({
          where: { id: row.id },
          data: {
            infraSyncState: state,
            infraSyncNote: `Status updated by sweep (${state.toLowerCase()})`,
          },
        });
        updatedCount++;
        logger.info(
          { requestId: row.id, prNumber: row.infraPrNumber, state },
          'Synced open secret ingestion deployment PR state from GitHub',
        );
      }
    }
    return updatedCount;
  }
}

export const secretIngestionService = new SecretIngestionService();
export default secretIngestionService;
