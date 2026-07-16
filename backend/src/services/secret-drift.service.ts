import prisma from '../config/prisma';
import { getSecretsManagerService } from './secrets-manager.service';
import {
  DriftManifest,
  getInfraRepoSyncService,
  isInfraAutoMergeEnabled,
  isInfraRepoEnabled,
} from './infra-repo-sync.service';
import {
  assertSecretsPlatform,
  isSecretsFamilyPlatform,
  secretsFamilyPlatforms,
} from './secret-ingestion.service';
import notificationService from './notification.service';
import logger from '../utils/logger';
import { AuthenticatedUser } from '../middleware/auth.middleware';
import { getManageableGroupIds } from '../utils/authz';
import { AuthorizationError, ValidationError } from '../utils/errors';

/** Default / prod Secret Ingestion instance key. */
const PLATFORM = 'secrets';

/**
 * Upper bound on how many in-scope secrets a single scan reads from AWS. A wildcard-all group
 * (`*`) makes the scope the whole account, and each secret is one GetSecretValue call, so this
 * caps the blast radius. When it trips, `truncated` is set and logged — never silently dropped.
 */
const MAX_DRIFT_SECRETS = 500;

/** A group whose grants own secrets, with its parsed externalGroupId. */
interface OwningGroup {
  id: string;
  name: string;
  externalGroupId: string;
}

/** One consuming manifest's registered-vs-AWS state (subset of DriftManifest for the wire). */
export interface DriftManifestView {
  path: string;
  env: string;
  format: string;
  registeredKeys: string[];
  missingKeys: string[];
  unmatched: boolean;
}

/** Drift for a single secret between AWS Secrets Manager and the infra-deployment manifests. */
export interface SecretDrift {
  secretName: string;
  groupId: string;
  groupName: string;
  awsExists: boolean;
  awsKeyCount: number;
  /** In AWS, not enumerated in ≥1 consuming manifest → the CSI driver won't sync it. FIXABLE. */
  missingInManifest: string[];
  /** Enumerated in a manifest, absent from AWS → dangling reference. Report-only. */
  missingInAws: string[];
  /** Subset of missingInAws an admin has marked "ignore" — still shown here, but excluded from
   * scheduled-scan notifications so an unrelated change elsewhere on the secret doesn't
   * re-surface a dangling key that's already been acknowledged as low-priority. */
  missingInAwsIgnored: string[];
  /** Consuming manifests referencing the secret whose key-list shape couldn't be parsed. */
  unmatchedManifests: string[];
  manifests: DriftManifestView[];
  /** True when there is at least one AWS key a draft PR could register (missingInManifest). */
  fixable: boolean;
}

/** A secret whose drift check threw — its true state is UNKNOWN, not "in sync". */
export interface DriftFailure {
  secretName: string;
  error: string;
}

export interface DriftReport {
  platform: string;
  infraEnabled: boolean;
  scannedSecretCount: number;
  truncated: boolean;
  generatedAt: string;
  drifts: SecretDrift[];
  /**
   * Secrets that could not be checked at all. Load-bearing: a failed check yields no drift entry,
   * so without this an all-errors scan is indistinguishable from a clean one — the report reads
   * "N scanned, no drift" while actually knowing nothing. Callers must treat a non-empty `failed`
   * as "the report is incomplete", never as "these are fine".
   */
  failed: DriftFailure[];
}

export class SecretDriftService {
  /**
   * Stable equality key for a secret's drift — used by the scheduled scan to avoid re-notifying
   * admins about drift they've already been told about. Order-independent (keys are sorted).
   */
  fingerprint(d: SecretDrift): string {
    const s = (a: string[]) => [...a].sort();
    return JSON.stringify({
      m: s(d.missingInManifest),
      a: s(d.missingInAws),
      x: s(d.unmatchedManifests),
    });
  }

  /** Active secrets groups on a platform that carry an externalGroupId (own some secret scope). */
  private async groupsForScope(
    platform: string,
    scope: { all: boolean; groupIds: string[] },
  ): Promise<OwningGroup[]> {
    const rows = await prisma.group.findMany({
      where: {
        platform,
        isActive: true,
        externalGroupId: { not: null },
        ...(scope.all ? {} : { id: { in: scope.groupIds } }),
      },
      select: { id: true, name: true, externalGroupId: true },
    });
    return rows
      .filter((g): g is OwningGroup => !!g.externalGroupId)
      .map((g) => ({
        id: g.id,
        name: g.name,
        externalGroupId: g.externalGroupId,
      }));
  }

  /**
   * Resolve the concrete in-scope secret names (exact grants map to themselves; wildcard/prefix
   * grants expand LIVE against AWS ListSecrets) with a deterministic owning group per name.
   */
  private async resolveScopedSecrets(
    platform: string,
    groups: OwningGroup[],
  ): Promise<{
    names: { secretName: string; group: OwningGroup }[];
    truncated: boolean;
  }> {
    const svc = getSecretsManagerService(platform);
    // Sort groups for deterministic ownership when a secret matches more than one.
    const ordered = [...groups].sort((a, b) => a.id.localeCompare(b.id));

    const patternsByGroup = ordered
      .map((g) => {
        try {
          return {
            group: g,
            patterns: svc.parseScopePatterns(g.externalGroupId),
          };
        } catch {
          return null;
        }
      })
      .filter(
        (
          x,
        ): x is {
          group: OwningGroup;
          patterns: ReturnType<typeof svc.parseScopePatterns>;
        } => x !== null,
      );

    const needsLive = patternsByGroup.some((pg) => pg.patterns.some((p) => p.kind !== 'exact'));
    const allNames = needsLive ? await svc.listAllAwsSecrets() : [];

    // secretName -> first owning group (stable, since `ordered` is sorted).
    const owner = new Map<string, OwningGroup>();
    for (const { group, patterns } of patternsByGroup) {
      for (const p of patterns) {
        if (p.kind === 'exact') {
          if (!owner.has(p.name)) {
            owner.set(p.name, group);
          }
        } else {
          for (const name of allNames) {
            if (svc.matchesPattern(p, name) && !owner.has(name)) {
              owner.set(name, group);
            }
          }
        }
      }
    }

    const all = [...owner.entries()]
      .map(([secretName, group]) => ({ secretName, group }))
      .sort((a, b) => a.secretName.localeCompare(b.secretName));
    const truncated = all.length > MAX_DRIFT_SECRETS;
    return {
      names: truncated ? all.slice(0, MAX_DRIFT_SECRETS) : all,
      truncated,
    };
  }

  /** Compute drift for one already-resolved secret. Returns null when the secret is fully in sync. */
  private async driftForSecret(
    platform: string,
    secretName: string,
    group: OwningGroup,
    ignoredKeys: Set<string> = new Set(),
  ): Promise<SecretDrift | null> {
    const svc = getSecretsManagerService(platform);
    const { exists, keys: awsKeys } = await svc.listSecretKeys(secretName);
    const manifests: DriftManifest[] = await getInfraRepoSyncService(platform).resolveDrift(
      secretName,
      awsKeys,
    );

    const registeredUnion = new Set<string>();
    for (const m of manifests) {
      for (const k of m.registeredKeys) {
        registeredUnion.add(k);
      }
    }

    const missingInManifest = [...new Set(manifests.flatMap((m) => m.missingKeys))].sort();
    const awsSet = new Set(awsKeys);
    const missingInAws = [...registeredUnion].filter((k) => !awsSet.has(k)).sort();
    const missingInAwsIgnored = missingInAws.filter((k) => ignoredKeys.has(k));
    const unmatchedManifests = manifests.filter((m) => m.unmatched).map((m) => m.path);

    // A secret with no consuming manifest at all is NOT drift — there's nothing for its keys
    // to disagree with. Drift only exists once at least one manifest actually references the
    // secret and its registered keys don't match AWS. Ignored missingInAws keys still count
    // toward "has drift" (the card stays visible so an admin can un-ignore it) — only the
    // scheduled-notification path treats them as resolved.
    const hasDrift =
      manifests.length > 0 &&
      (missingInManifest.length > 0 || missingInAws.length > 0 || unmatchedManifests.length > 0);
    if (!hasDrift) {
      return null;
    }

    return {
      secretName,
      groupId: group.id,
      groupName: group.name,
      awsExists: exists,
      awsKeyCount: awsKeys.length,
      missingInManifest,
      missingInAws,
      missingInAwsIgnored,
      unmatchedManifests,
      manifests: manifests.map((m) => ({
        path: m.path,
        env: m.env,
        format: m.format,
        registeredKeys: m.registeredKeys,
        missingKeys: m.missingKeys,
        unmatched: m.unmatched,
      })),
      fixable: missingInManifest.length > 0,
    };
  }

  /**
   * Currently-ignored missingInAws keys for a platform, keyed by secretName. Persisted as
   * audit rows (SECRET_DRIFT_KEY_IGNORED / _UNIGNORED) rather than a dedicated table — same
   * "replay the audit trail" pattern scanAndNotify already uses for fingerprint dedup. Latest
   * row per (secretName, key) wins.
   */
  private async loadIgnoredKeys(platform: string): Promise<Map<string, Set<string>>> {
    const rows = await prisma.auditEntry.findMany({
      where: {
        action: {
          in: ['SECRET_DRIFT_KEY_IGNORED', 'SECRET_DRIFT_KEY_UNIGNORED'],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 5000,
      select: { action: true, details: true },
    });
    const decided = new Set<string>(); // secretName::key pairs already resolved (latest wins)
    const ignored = new Map<string, Set<string>>();
    for (const row of rows) {
      const d = (row.details ?? {}) as {
        platform?: string;
        secretName?: string;
        key?: string;
      };
      if (d.platform !== platform || !d.secretName || !d.key) {
        continue;
      }
      const pairKey = `${d.secretName}::${d.key}`;
      if (decided.has(pairKey)) {
        continue;
      }
      decided.add(pairKey);
      if (row.action === 'SECRET_DRIFT_KEY_IGNORED') {
        const set = ignored.get(d.secretName) ?? new Set<string>();
        set.add(d.key);
        ignored.set(d.secretName, set);
      }
    }
    return ignored;
  }

  /** Core scan: compute drift across a set of owning groups on one platform. */
  private async computeDrift(platform: string, groups: OwningGroup[]): Promise<DriftReport> {
    const infraEnabled = isInfraRepoEnabled(platform);
    const base: DriftReport = {
      platform,
      infraEnabled,
      scannedSecretCount: 0,
      truncated: false,
      generatedAt: new Date().toISOString(),
      drifts: [],
      failed: [],
    };
    // With no infra-deployment repo wired there are no manifests to compare against — every
    // secret would look "unconsumed", which is noise, not drift. Report nothing instead.
    if (!infraEnabled || groups.length === 0) {
      return base;
    }

    const { names, truncated } = await this.resolveScopedSecrets(platform, groups);
    if (truncated) {
      logger.warn(
        { platform, scanned: MAX_DRIFT_SECRETS },
        `Secret drift scan capped at ${MAX_DRIFT_SECRETS} secrets — some in-scope secrets were not checked`,
      );
    }

    const ignoredBySecret = await this.loadIgnoredKeys(platform);

    const drifts: SecretDrift[] = [];
    const failed: DriftFailure[] = [];
    // Bounded concurrency: each secret is an independent AWS read + (cached) manifest lookup.
    const CONCURRENCY = 6;
    let next = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, names.length) }, async () => {
      while (next < names.length) {
        const i = next++;
        const { secretName, group } = names[i];
        try {
          const drift = await this.driftForSecret(
            platform,
            secretName,
            group,
            ignoredBySecret.get(secretName),
          );
          if (drift) {
            drifts.push(drift);
          }
        } catch (err: any) {
          // Record it, don't just swallow it: a failed check produces no drift entry, so
          // dropping it here silently downgrades "we don't know" to "no drift found".
          failed.push({
            secretName,
            error: err?.message ? String(err.message) : String(err),
          });
          logger.warn(
            { platform, secretName, error: err.message },
            'Secret drift check failed for one secret — reporting it as unchecked',
          );
        }
      }
    });
    await Promise.all(workers);

    if (failed.length > 0) {
      logger.error(
        { platform, failed: failed.length, of: names.length },
        'Secret drift scan could not check every secret — report is incomplete',
      );
    }
    drifts.sort((a, b) => a.secretName.localeCompare(b.secretName));
    failed.sort((a, b) => a.secretName.localeCompare(b.secretName));
    return {
      ...base,
      scannedSecretCount: names.length,
      truncated,
      drifts,
      failed,
    };
  }

  /**
   * Drift report scoped to what an admin manages: super/platform admins see every secrets group
   * on the platform; a group admin sees only their groups. Returns an empty report when the
   * caller manages nothing on the platform.
   */
  async detectDrift(user: AuthenticatedUser, platform: string = PLATFORM): Promise<DriftReport> {
    const key = assertSecretsPlatform(platform);
    const scope = await getManageableGroupIds(user, key);
    if (!scope.all && scope.groupIds.length === 0) {
      return {
        platform: key,
        infraEnabled: isInfraRepoEnabled(key),
        scannedSecretCount: 0,
        truncated: false,
        generatedAt: new Date().toISOString(),
        drifts: [],
        failed: [],
      };
    }
    const groups = await this.groupsForScope(key, scope);
    return this.computeDrift(key, groups);
  }

  /**
   * Finds a secrets group the caller manages whose scope actually covers `secretName` — this
   * both authorizes any per-secret drift action and gives the audit row a real owning group.
   * Shared by resolveDrift/mergeDrift/ignoreDriftKey/unignoreDriftKey.
   */
  private async resolveOwnerGroup(
    key: string,
    user: AuthenticatedUser,
    secretName: string,
  ): Promise<OwningGroup> {
    const svc = getSecretsManagerService(key);
    const scope = await getManageableGroupIds(user, key);
    if (!scope.all && scope.groupIds.length === 0) {
      throw new AuthorizationError('You do not manage any secrets groups on this platform.');
    }
    const groups = await this.groupsForScope(key, scope);
    const owner = groups.find((g) => {
      let patterns;
      try {
        patterns = svc.parseScopePatterns(g.externalGroupId);
      } catch {
        return false;
      }
      return patterns.some((p) => svc.matchesPattern(p, secretName));
    });
    if (!owner) {
      throw new AuthorizationError(
        `You do not have permission to reconcile secret "${secretName}".`,
      );
    }
    return owner;
  }

  /**
   * Opens a DRAFT infra-deployment PR that registers the keys currently in AWS but missing from
   * the manifests for `secretName`. When auto-merge is off (default), a human reviews + merges it
   * manually on GitHub. When auto-merge is on, Hermes merges immediately after opening.
   * Authorization: the caller must manage a secrets group whose scope covers the secret.
   */
  async resolveDrift(user: AuthenticatedUser, secretName: string, platform: string = PLATFORM) {
    const key = assertSecretsPlatform(platform);
    if (!isInfraRepoEnabled(key)) {
      throw new ValidationError(
        `The "${key}" Secret Ingestion instance has no infra-deployment repo configured, so there is nothing to reconcile.`,
      );
    }
    const owner = await this.resolveOwnerGroup(key, user, secretName);

    const drift = await this.driftForSecret(key, secretName, owner);
    if (!drift || drift.missingInManifest.length === 0) {
      return {
        state: 'SKIPPED' as const,
        secretName,
        note: 'No keys are missing from the manifests — nothing to reconcile.',
      };
    }

    // A stable per-secret requestId keeps the branch deterministic, so re-clicking Solve adopts
    // the already-open PR instead of racing to create a second one (openPrForRequest is idempotent).
    const result = await getInfraRepoSyncService(key).openPrForRequest({
      requestId: 'drift',
      secretName,
      proposedKeys: drift.missingInManifest,
    });

    await prisma.auditEntry.create({
      data: {
        action: 'SECRET_DRIFT_RESOLVED',
        performerId: user.id,
        performerName: user.username,
        groupId: owner.id,
        details: {
          platform: key,
          secretName,
          keys: drift.missingInManifest,
          prNumber: result.prNumber ?? null,
          prUrl: result.prUrl ?? null,
          prState: result.state,
          note: result.note ?? null,
        } as any,
      },
    });

    // Auto-merge ON: immediately merge the just-opened PR so "Solve drift" is a one-click
    // full resolution. When off (default), the PR stays open for a human to review and merge
    // manually on GitHub (the existing two-step flow).
    if (result.state === 'OPEN' && isInfraAutoMergeEnabled(key)) {
      const mergeResult = await getInfraRepoSyncService(key).mergeDriftPr(
        secretName,
        drift.missingInManifest,
      );
      await prisma.auditEntry.create({
        data: {
          action: 'SECRET_DRIFT_MERGED',
          performerId: user.id,
          performerName: user.username,
          groupId: owner.id,
          details: {
            platform: key,
            secretName,
            keys: drift.missingInManifest,
            prNumber: mergeResult.prNumber ?? null,
            prUrl: mergeResult.prUrl ?? null,
            prState: mergeResult.state,
            note: mergeResult.note ?? null,
          } as any,
        },
      });
      return {
        state: mergeResult.state,
        secretName,
        keys: drift.missingInManifest,
        prNumber: mergeResult.prNumber ?? null,
        prUrl: mergeResult.prUrl ?? null,
        branch: result.branch ?? null,
        note: mergeResult.note ?? null,
      };
    }

    return {
      state: result.state,
      secretName,
      keys: drift.missingInManifest,
      prNumber: result.prNumber ?? null,
      prUrl: result.prUrl ?? null,
      branch: result.branch ?? null,
      note: result.note ?? null,
    };
  }

  /**
   * Marks a single missingInAws (dangling) key as ignored — it keeps showing up in the
   * on-demand drift report (still visible, badged), but the scheduled scan stops counting it
   * toward "new/changed drift" for notification purposes. Persisted as an audit row (no
   * dedicated table) — see loadIgnoredKeys. Authorization mirrors resolveDrift.
   */
  async ignoreDriftKey(
    user: AuthenticatedUser,
    secretName: string,
    ignoreKey: string,
    platform: string = PLATFORM,
  ): Promise<{ secretName: string; key: string; ignored: true }> {
    const key = assertSecretsPlatform(platform);
    const owner = await this.resolveOwnerGroup(key, user, secretName);
    await prisma.auditEntry.create({
      data: {
        action: 'SECRET_DRIFT_KEY_IGNORED',
        performerId: user.id,
        performerName: user.username,
        groupId: owner.id,
        details: { platform: key, secretName, key: ignoreKey } as any,
      },
    });
    return { secretName, key: ignoreKey, ignored: true };
  }

  /** Reverses ignoreDriftKey — the key resumes counting toward drift notifications. */
  async unignoreDriftKey(
    user: AuthenticatedUser,
    secretName: string,
    ignoreKey: string,
    platform: string = PLATFORM,
  ): Promise<{ secretName: string; key: string; ignored: false }> {
    const key = assertSecretsPlatform(platform);
    const owner = await this.resolveOwnerGroup(key, user, secretName);
    await prisma.auditEntry.create({
      data: {
        action: 'SECRET_DRIFT_KEY_UNIGNORED',
        performerId: user.id,
        performerName: user.username,
        groupId: owner.id,
        details: { platform: key, secretName, key: ignoreKey } as any,
      },
    });
    return { secretName, key: ignoreKey, ignored: false };
  }

  /**
   * Scheduled scan for one platform: computes drift across ALL secrets groups on the platform,
   * then notifies admins about secrets whose drift is new or changed since the last alert
   * (tracked via SECRET_DRIFT_ALERTED audit rows, so we don't re-notify the same drift each run).
   * Best-effort: never throws.
   */
  async scanAndNotify(platform: string): Promise<{ drifting: number; alerted: number }> {
    const key = platform.toLowerCase();
    if (!isSecretsFamilyPlatform(key) || !isInfraRepoEnabled(key)) {
      return { drifting: 0, alerted: 0 };
    }
    const groups = await this.groupsForScope(key, { all: true, groupIds: [] });
    const report = await this.computeDrift(key, groups);
    if (report.drifts.length === 0) {
      return { drifting: 0, alerted: 0 };
    }

    // Ignored missingInAws keys don't count toward notifications (that's the whole point of
    // ignoring one) — strip them before fingerprinting/alerting, and drop any secret whose
    // drift is entirely resolved once its ignored keys are excluded. The on-demand report
    // (computeDrift above) is untouched — it still shows ignored keys, badged, for visibility.
    const effectiveDrifts = report.drifts
      .map((d) => ({
        ...d,
        missingInAws: d.missingInAws.filter((k) => !d.missingInAwsIgnored.includes(k)),
      }))
      .filter(
        (d) =>
          d.missingInManifest.length > 0 ||
          d.missingInAws.length > 0 ||
          d.unmatchedManifests.length > 0,
      );
    if (effectiveDrifts.length === 0) {
      return { drifting: report.drifts.length, alerted: 0 };
    }

    // Last-alerted fingerprint per secret, newest first (the first row seen per secret wins).
    const previous = await prisma.auditEntry.findMany({
      where: { action: 'SECRET_DRIFT_ALERTED' },
      orderBy: { createdAt: 'desc' },
      take: 2000,
      select: { details: true },
    });
    const lastFingerprint = new Map<string, string>();
    for (const row of previous) {
      const d = (row.details ?? {}) as {
        platform?: string;
        secretName?: string;
        fingerprint?: string;
      };
      if (d.platform !== key || !d.secretName || !d.fingerprint) {
        continue;
      }
      if (!lastFingerprint.has(d.secretName)) {
        lastFingerprint.set(d.secretName, d.fingerprint);
      }
    }

    const newlyDrifting = effectiveDrifts.filter(
      (d) => lastFingerprint.get(d.secretName) !== this.fingerprint(d),
    );
    if (newlyDrifting.length === 0) {
      return { drifting: report.drifts.length, alerted: 0 };
    }

    // Record the new fingerprints first so a notification failure below can't cause the same
    // drift to be alerted again on the next run (the audit rows are the dedupe state).
    await prisma.auditEntry.createMany({
      data: newlyDrifting.map((d) => ({
        action: 'SECRET_DRIFT_ALERTED',
        performerId: 'system',
        performerName: 'Drift Scan',
        groupId: d.groupId,
        details: {
          platform: key,
          secretName: d.secretName,
          fingerprint: this.fingerprint(d),
          missingInManifest: d.missingInManifest,
          missingInAws: d.missingInAws,
        } as any,
      })),
    });

    await notificationService.notifySecretDriftDetected(key, newlyDrifting);
    logger.warn(
      {
        platform: key,
        drifting: report.drifts.length,
        alerted: newlyDrifting.length,
      },
      'Secret drift detected — admins notified',
    );
    return { drifting: report.drifts.length, alerted: newlyDrifting.length };
  }

  /** Scan every enabled, infra-wired secrets instance and notify on new drift. */
  async scanAllAndNotify(): Promise<void> {
    for (const platform of secretsFamilyPlatforms()) {
      if (!isInfraRepoEnabled(platform)) {
        continue;
      }
      try {
        await this.scanAndNotify(platform);
      } catch (err: any) {
        logger.warn({ platform, error: err.message }, 'Secret drift scan failed for a platform');
      }
    }
  }
}

export const secretDriftService = new SecretDriftService();
export default secretDriftService;
