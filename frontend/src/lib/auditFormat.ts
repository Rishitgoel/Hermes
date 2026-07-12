/** Shared between AuditLog.tsx (table) and AuditDetailModal.tsx (drill-in) so both
 * surfaces stay in sync — defined here rather than in either component to avoid a
 * circular import between the page and the modal it renders.
 *
 * This is the audit event catalog: every action the backend writes is mapped to a
 * human-readable label, a category, an outcome, and a one-line plain-English summary
 * (who did what to whom, and the result) — the structure large audit systems
 * (CloudTrail, Stripe, GitHub) use so a log line is debuggable without opening raw JSON.
 * Unknown/new actions degrade gracefully to a humanized code + generic summary.
 */
export interface AuditLogEntry {
  id: string;
  action: string;
  performerId: string;
  performerName: string;
  targetUserId: string | null;
  targetUserName: string | null;
  groupId: string | null;
  accessRequestId: string | null;
  details: any;
  ipAddress: string | null;
  createdAt: string;
}

/** Audit actions produced by a request moving through review and execution. */
export const REQUEST_FLOW_ACTIONS = new Set([
  'REQUEST_CREATED',
  'REQUEST_REJECTED',
  'ACCESS_GRANTED',
  'ACCESS_QUEUED_FOR_SETUP',
  'ACCESS_LEVEL_CHANGED',
  'ACCESS_RENEWED',
  'USER_CREATION_RESUBMITTED',
  'USER_CREATION_APPROVED',
  'USER_CREATION_REJECTED',
  'SECRET_INGESTION_SUBMITTED',
  'SECRET_INGESTION_APPLIED',
  'SECRET_INGESTION_PARTIALLY_APPLIED',
  'SECRET_INGESTION_APPLY_FAILED',
  'SECRET_INGESTION_REJECTED',
  'ZK_CHANGE_SUBMITTED',
  'ZK_CHANGE_APPLIED',
  'ZK_CHANGE_PARTIALLY_APPLIED',
  'ZK_CHANGE_APPLY_FAILED',
  'ZK_CHANGE_REJECTED',
]);

const REQUEST_CREATION_ACTIONS = new Set([
  'REQUEST_CREATED',
  'USER_CREATION_RESUBMITTED',
  'SECRET_INGESTION_SUBMITTED',
  'ZK_CHANGE_SUBMITTED',
]);

export interface RequestParticipants {
  maker: string | null;
  checker: string | null;
}

/**
 * Identify the requester (maker) and reviewer (checker) for a request-lifecycle
 * audit entry. Older rows did not store these values in details, so use the
 * persisted target and performer fields as a backwards-compatible fallback.
 */
export const requestParticipants = (entry: AuditLogEntry): RequestParticipants | null => {
  if (!REQUEST_FLOW_ACTIONS.has(entry.action)) return null;

  const details = entry.details ?? {};
  const isCreation = REQUEST_CREATION_ACTIONS.has(entry.action);
  return {
    maker: details.requesterName ?? (isCreation ? entry.performerName : entry.targetUserName),
    checker: details.reviewerName ?? (isCreation ? null : entry.performerName),
  };
};

export type AuditCategory =
  | 'Access'
  | 'Requests'
  | 'Accounts'
  | 'Groups & levels'
  | 'Admin roles'
  | 'Secrets'
  | 'ZooKeeper'
  | 'Sync & system';

/** success = state changed as intended · failure = the operation itself failed ·
 * partial = some items applied, some didn't · removal = deliberate take-away
 * (revoke/reject/delete) · neutral = informational. */
export type AuditOutcome = 'success' | 'failure' | 'partial' | 'removal' | 'neutral';

interface CatalogEntry {
  label: string;
  category: AuditCategory;
  outcome: AuditOutcome;
  /** One-sentence summary. `group` is the resolved group name (from the page's group
   * list, details.groupName, or the raw id). All fields defensive — old rows miss many. */
  describe: (e: AuditLogEntry, group: string | null) => string;
}

// ── small formatting helpers ─────────────────────────────────────────────────────────
const nm = (s?: string | null): string => (s ? s.replace(/_/g, ' ') : 'Unknown');
const actor = (e: AuditLogEntry): string =>
  e.performerName?.startsWith('system') ? 'System' : nm(e.performerName);
const target = (e: AuditLogEntry): string => nm(e.targetUserName ?? e.targetUserId);
const dur = (d?: string | null): string =>
  d ? String(d).replace(/_/g, ' ').toLowerCase() : '';
const shortDate = (iso?: string | null): string =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : '';
const inGroup = (group: string | null): string => (group ? ` — group "${group}"` : '');
const withLevel = (d: any): string => (d?.levelName ? ` (${d.levelName} level)` : '');
const quoteNote = (note?: string | null): string => (note ? ` — "${note}"` : '');
/** "a, b, c" or "a, b, c +2 more" for long key lists. */
const keyList = (keys: unknown, max = 4): string => {
  if (!Array.isArray(keys) || keys.length === 0) return '';
  const shown = keys.slice(0, max).join(', ');
  const extra = keys.length > max ? ` +${keys.length - max} more` : '';
  return `${shown}${extra}`;
};
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

// ── the catalog ──────────────────────────────────────────────────────────────────────
const CATALOG: Record<string, CatalogEntry> = {
  // Requests ---------------------------------------------------------------------------
  REQUEST_CREATED: {
    label: 'Access requested',
    category: 'Requests',
    outcome: 'neutral',
    describe: (e, g) => {
      const d = e.details ?? {};
      const who = nm(d.requesterName ?? e.performerName);
      const onBehalf = d.reviewerName && d.reviewerName !== d.requesterName;
      const base = `${who} requested access to "${g ?? 'a group'}"${withLevel(d)}${
        d.duration ? ` for ${dur(d.duration)}` : ''
      }`;
      return onBehalf ? `${base} (created by admin ${nm(d.reviewerName)})` : base;
    },
  },
  REQUEST_REJECTED: {
    label: 'Request rejected',
    category: 'Requests',
    outcome: 'removal',
    describe: (e, g) => {
      const d = e.details ?? {};
      return `${nm(d.reviewerName ?? e.performerName)} rejected ${nm(
        d.requesterName ?? e.targetUserName,
      )}'s request for "${g ?? 'a group'}"${quoteNote(d.note)}`;
    },
  },

  // Access -----------------------------------------------------------------------------
  ACCESS_GRANTED: {
    label: 'Access granted',
    category: 'Access',
    outcome: 'success',
    describe: (e, g) => {
      const d = e.details ?? {};
      if (d.source === 'default-group-auto-membership') {
        return `${target(e)} was auto-added to the "${d.groupName ?? g ?? 'default'}" group`;
      }
      const expiry = d.expiresAt ? `, expires ${shortDate(d.expiresAt)}` : ', permanent';
      return `${nm(d.reviewerName) !== 'Unknown' ? nm(d.reviewerName) : actor(e)} granted ${target(
        e,
      )} access to "${g ?? 'a group'}"${withLevel(d)}${expiry}`;
    },
  },
  ACCESS_QUEUED_FOR_SETUP: {
    label: 'Approved · awaiting account',
    category: 'Access',
    outcome: 'neutral',
    describe: (e, g) => {
      const d = e.details ?? {};
      return `${nm(d.reviewerName ?? e.performerName)} approved ${target(e)}'s request for "${
        g ?? 'a group'
      }" — provisioning waits for their platform account setup`;
    },
  },
  ACCESS_RENEWED: {
    label: 'Access renewed',
    category: 'Access',
    outcome: 'success',
    describe: (e, g) => {
      const d = e.details ?? {};
      const until = d.newExpiresAt ? ` until ${shortDate(d.newExpiresAt)}` : '';
      return `${actor(e)} renewed ${target(e)}'s access to "${g ?? 'a group'}"${until}`;
    },
  },
  ACCESS_LEVEL_CHANGED: {
    label: 'Level changed',
    category: 'Access',
    outcome: 'success',
    describe: (e, g) => {
      const d = e.details ?? {};
      return `${actor(e)} moved ${target(e)} from ${d.fromLevelName ?? 'no level'} to ${
        d.toLevelName ?? 'no level'
      } in "${g ?? 'a group'}"`;
    },
  },
  ACCESS_REVOKED: {
    label: 'Access revoked',
    category: 'Access',
    outcome: 'removal',
    describe: (e, g) => {
      const d = e.details ?? {};
      return `${actor(e)} revoked ${target(e)}'s access to "${g ?? 'a group'}"${
        d.reason ? ` — reason: "${d.reason}"` : ''
      }`;
    },
  },
  ACCESS_BULK_REVOKED: {
    label: 'Bulk revoke',
    category: 'Access',
    outcome: 'removal',
    describe: (e) => {
      const d = e.details ?? {};
      const count = d.revokedCount ?? (Array.isArray(d.revoked) ? d.revoked.length : null);
      return `${actor(e)} bulk-revoked ${count != null ? plural(count, 'grant') : 'grants'} held by ${target(e)}${
        d.failedCount ? ` (${d.failedCount} failed)` : ''
      }`;
    },
  },
  ACCESS_EXPIRED: {
    label: 'Access expired',
    category: 'Access',
    outcome: 'removal',
    describe: (e, g) => `${target(e)}'s time-bound access to "${g ?? 'a group'}" expired and was removed`,
  },
  ACCESS_EXPIRY_FAILED: {
    label: 'Expiry failed',
    category: 'Access',
    outcome: 'failure',
    describe: (e, g) => {
      const d = e.details ?? {};
      return `Could not deprovision ${target(e)}'s expired access to "${g ?? 'a group'}"${
        d.attempts != null ? ` after ${plural(d.attempts, 'attempt')}` : ''
      }${d.error ? ` — ${d.error}` : ''}`;
    },
  },
  ACCESS_IMPORTED: {
    label: 'Access imported',
    category: 'Access',
    outcome: 'success',
    describe: (e, g) => {
      const d = e.details ?? {};
      return `${target(e)}'s existing platform membership was imported as a Hermes grant for "${
        d.groupName ?? g ?? 'a group'
      }"${withLevel(d)}`;
    },
  },
  PROVISION_FAILED: {
    label: 'Provisioning failed',
    category: 'Access',
    outcome: 'failure',
    describe: (e, g) => {
      const d = e.details ?? {};
      return `Provisioning ${target(e)} onto "${g ?? 'a group'}" failed${d.error ? ` — ${d.error}` : ''}`;
    },
  },

  // Accounts ---------------------------------------------------------------------------
  USER_CREATION_APPROVED: {
    label: 'Account approved',
    category: 'Accounts',
    outcome: 'success',
    describe: (e) => {
      const d = e.details ?? {};
      return `${actor(e)} approved ${target(e)}'s ${d.platform ?? 'platform'} account request${
        d.shortCircuited ? ' (account already existed)' : ''
      }`;
    },
  },
  USER_CREATION_REJECTED: {
    label: 'Account rejected',
    category: 'Accounts',
    outcome: 'removal',
    describe: (e) => {
      const d = e.details ?? {};
      return `${actor(e)} rejected ${target(e)}'s ${d.platform ?? 'platform'} account request${quoteNote(d.note)}`;
    },
  },
  USER_CREATION_COMPLETED: {
    label: 'Account ready',
    category: 'Accounts',
    outcome: 'success',
    describe: (e) => {
      const d = e.details ?? {};
      return `${target(e)}'s ${d.platform ?? 'platform'} account is set up and ready`;
    },
  },
  USER_CREATION_RESUBMITTED: {
    label: 'Account resubmitted',
    category: 'Accounts',
    outcome: 'neutral',
    describe: (e) => {
      const d = e.details ?? {};
      return `${actor(e)} resubmitted a ${d.platform ?? 'platform'} account request`;
    },
  },
  USER_CREATION_ADMIN_CREATED: {
    label: 'Account created by admin',
    category: 'Accounts',
    outcome: 'success',
    describe: (e) => {
      const d = e.details ?? {};
      return `${actor(e)} created a ${d.platform ?? 'platform'} account for ${target(e)}`;
    },
  },
  PLATFORM_ACCOUNT_DISABLED: {
    label: 'Account disabled',
    category: 'Accounts',
    outcome: 'removal',
    describe: (e) => {
      const d = e.details ?? {};
      const revoked = d.grantsRevoked ? ` and ${plural(d.grantsRevoked, 'grant')} auto-revoked` : '';
      return `${actor(e)} ${d.reversible ? 'disabled' : 'permanently removed'} ${target(e)}'s ${
        d.platform ?? 'platform'
      } account${revoked}`;
    },
  },
  ACCOUNTS_BULK_DISABLED: {
    label: 'Accounts bulk-disabled',
    category: 'Accounts',
    outcome: 'removal',
    describe: (e) => {
      const d = e.details ?? {};
      const count = d.disabledCount ?? (Array.isArray(d.disabled) ? d.disabled.length : null);
      return `${actor(e)} disabled ${count != null ? plural(count, 'platform account') : 'platform accounts'} for ${target(
        e,
      )}${d.autoRevokedGrantCount ? ` (${plural(d.autoRevokedGrantCount, 'grant')} auto-revoked)` : ''}`;
    },
  },

  // Groups & levels ---------------------------------------------------------------------
  GROUP_CREATED: {
    label: 'Group created',
    category: 'Groups & levels',
    outcome: 'success',
    describe: (e, g) => {
      const d = e.details ?? {};
      const name = d.name ?? d.slug ?? g ?? 'a group';
      return d.autoCreated || d.source === 'platform-sync'
        ? `Platform sync discovered "${name}" on ${d.platform ?? 'the platform'} and created it`
        : `${actor(e)} created group "${name}"${d.platform ? ` on ${d.platform}` : ''}`;
    },
  },
  GROUP_UPDATED: {
    label: 'Group updated',
    category: 'Groups & levels',
    outcome: 'neutral',
    describe: (e, g) => {
      const d = e.details ?? {};
      const name = d.name ?? d.slug ?? g ?? 'a group';
      const changed = Array.isArray(d.changed) && d.changed.length > 0 ? ` — changed ${d.changed.join(', ')}` : '';
      if (d.relinkedFrom || d.relinkedTo) return `Platform sync re-linked "${name}" to its backing group`;
      return `${actor(e)} updated group "${name}"${changed}`;
    },
  },
  GROUP_ARCHIVED: {
    label: 'Group archived',
    category: 'Groups & levels',
    outcome: 'removal',
    describe: (e, g) => {
      const d = e.details ?? {};
      return `${actor(e)} archived group "${d.name ?? d.slug ?? g ?? 'a group'}"${
        d.reason ? ` — ${d.reason}` : ''
      }`;
    },
  },
  GROUP_DELETED: {
    label: 'Group deleted',
    category: 'Groups & levels',
    outcome: 'removal',
    describe: (e, g) => {
      const d = e.details ?? {};
      return `${actor(e)} deleted group "${d.name ?? d.slug ?? g ?? 'a group'}"${
        d.forced ? ' (including its history)' : ''
      }`;
    },
  },
  GROUP_LEVEL_CREATED: {
    label: 'Level created',
    category: 'Groups & levels',
    outcome: 'success',
    describe: (e, g) => {
      const d = e.details ?? {};
      return `${actor(e)} added level "${d.name ?? d.levelName ?? 'a level'}"${inGroup(g)}`;
    },
  },
  GROUP_LEVEL_UPDATED: {
    label: 'Level updated',
    category: 'Groups & levels',
    outcome: 'neutral',
    describe: (e, g) => {
      const d = e.details ?? {};
      const changed = Array.isArray(d.changed) && d.changed.length > 0 ? ` — changed ${d.changed.join(', ')}` : '';
      return `${actor(e)} updated level "${d.name ?? d.levelName ?? 'a level'}"${inGroup(g)}${changed}`;
    },
  },
  GROUP_LEVEL_DELETED: {
    label: 'Level deleted',
    category: 'Groups & levels',
    outcome: 'removal',
    describe: (e, g) => {
      const d = e.details ?? {};
      return `${actor(e)} deleted level "${d.name ?? d.levelName ?? 'a level'}"${inGroup(g)}`;
    },
  },
  GROUP_LEVEL_DEACTIVATED: {
    label: 'Level deactivated',
    category: 'Groups & levels',
    outcome: 'removal',
    describe: (e, g) => {
      const d = e.details ?? {};
      return `Level "${d.name ?? d.levelName ?? 'a level'}"${inGroup(g)} was deactivated (members keep access until expiry)`;
    },
  },
  GROUP_PATHS_RECONCILED: {
    label: 'Paths re-synced',
    category: 'Groups & levels',
    outcome: 'success',
    describe: (e, g) => {
      const d = e.details ?? {};
      const parts: string[] = [];
      if (Array.isArray(d.addedPaths) && d.addedPaths.length) parts.push(`${d.addedPaths.length} added`);
      if (Array.isArray(d.removedPaths) && d.removedPaths.length) parts.push(`${d.removedPaths.length} removed`);
      if (Array.isArray(d.updatedPaths) && d.updatedPaths.length) parts.push(`${d.updatedPaths.length} updated`);
      const delta = parts.length ? ` (${parts.join(', ')})` : '';
      return `Path list changed${inGroup(g)}${delta} — ${plural(d.memberCount ?? 0, 'member')} re-synced`;
    },
  },

  // Admin roles ------------------------------------------------------------------------
  PLATFORM_ADMIN_ASSIGNED: {
    label: 'Platform admin assigned',
    category: 'Admin roles',
    outcome: 'success',
    describe: (e) => {
      const d = e.details ?? {};
      return `${actor(e)} made ${target(e)} a platform admin of ${d.platform ?? 'a platform'}`;
    },
  },
  PLATFORM_ADMIN_REVOKED: {
    label: 'Platform admin revoked',
    category: 'Admin roles',
    outcome: 'removal',
    describe: (e) => {
      const d = e.details ?? {};
      return `${actor(e)} removed ${target(e)}'s platform-admin role on ${d.platform ?? 'a platform'}`;
    },
  },
  GROUP_ADMIN_ASSIGNED: {
    label: 'Group admin assigned',
    category: 'Admin roles',
    outcome: 'success',
    describe: (e, g) => {
      const d = e.details ?? {};
      return `${actor(e)} made ${target(e)} a group admin of "${g ?? d.slug ?? 'a group'}"`;
    },
  },
  GROUP_ADMIN_REVOKED: {
    label: 'Group admin revoked',
    category: 'Admin roles',
    outcome: 'removal',
    describe: (e, g) => {
      const d = e.details ?? {};
      return `${actor(e)} removed ${target(e)}'s group-admin role on "${g ?? d.slug ?? 'a group'}"`;
    },
  },
  ADMIN_RECONCILE_TRIGGERED: {
    label: 'Admin reconcile',
    category: 'Admin roles',
    outcome: 'neutral',
    describe: (e) => `${actor(e)} triggered a Keycloak ↔ database admin-role reconciliation`,
  },

  // Secrets ----------------------------------------------------------------------------
  SECRET_INGESTION_SUBMITTED: {
    label: 'Secret change submitted',
    category: 'Secrets',
    outcome: 'neutral',
    describe: (e) => {
      const d = e.details ?? {};
      const keys = keyList(d.keys);
      return `${actor(e)} staged ${plural(d.keyCount ?? (Array.isArray(d.keys) ? d.keys.length : 0), 'key')} for secret "${
        d.secretName ?? 'unknown'
      }"${keys ? `: ${keys}` : ''}`;
    },
  },
  SECRET_INGESTION_APPLIED: {
    label: 'Secret change applied',
    category: 'Secrets',
    outcome: 'success',
    describe: (e) => {
      const d = e.details ?? {};
      const keys = keyList(d.appliedKeys ?? d.approvedKeys);
      return `${actor(e)} approved and applied ${plural(d.approvedCount ?? 0, 'key')} to "${d.secretName ?? 'unknown'}"${
        keys ? `: ${keys}` : ''
      }`;
    },
  },
  SECRET_INGESTION_PARTIALLY_APPLIED: {
    label: 'Secret change partially applied',
    category: 'Secrets',
    outcome: 'partial',
    describe: (e) => {
      const d = e.details ?? {};
      const applied = keyList(d.appliedKeys ?? d.approvedKeys);
      const rejected = keyList(d.rejectedKeys);
      return `${actor(e)} applied ${plural(d.approvedCount ?? 0, 'key')}${applied ? ` (${applied})` : ''} and rejected ${
        d.rejectedCount ?? 0
      }${rejected ? ` (${rejected})` : ''} on "${d.secretName ?? 'unknown'}"`;
    },
  },
  SECRET_INGESTION_REJECTED: {
    label: 'Secret change rejected',
    category: 'Secrets',
    outcome: 'removal',
    describe: (e) => {
      const d = e.details ?? {};
      const keys = keyList(d.rejectedKeys);
      return `${actor(e)} rejected all ${plural(d.rejectedCount ?? 0, 'key')} staged for "${d.secretName ?? 'unknown'}"${
        keys ? `: ${keys}` : ''
      }`;
    },
  },
  SECRET_INGESTION_APPLY_FAILED: {
    label: 'Secret apply failed',
    category: 'Secrets',
    outcome: 'failure',
    describe: (e) => {
      const d = e.details ?? {};
      const keys = keyList(d.approvedKeys);
      return `Writing ${plural(d.approvedCount ?? 0, 'approved key')}${keys ? ` (${keys})` : ''} to "${
        d.secretName ?? 'unknown'
      }" failed${d.applyError ? ` — ${d.applyError}` : ''} (retryable)`;
    },
  },

  // ZooKeeper --------------------------------------------------------------------------
  ZK_CHANGE_SUBMITTED: {
    label: 'ZK change submitted',
    category: 'ZooKeeper',
    outcome: 'neutral',
    describe: (e) => {
      const d = e.details ?? {};
      const count = d.changeCount ?? (Array.isArray(d.changes) ? d.changes.length : 0);
      return `${actor(e)} submitted ${plural(count, 'ZooKeeper change')}${
        d.groupName ? ` for "${d.groupName}"` : ''
      } for review`;
    },
  },
  ZK_CHANGE_APPLIED: {
    label: 'ZK change applied',
    category: 'ZooKeeper',
    outcome: 'success',
    describe: (e) => {
      const d = e.details ?? {};
      return `${actor(e)} approved and applied ${plural(d.applied ?? d.approved ?? 0, 'ZooKeeper change')}${
        d.groupName ? ` for "${d.groupName}"` : ''
      }`;
    },
  },
  ZK_CHANGE_PARTIALLY_APPLIED: {
    label: 'ZK change partially applied',
    category: 'ZooKeeper',
    outcome: 'partial',
    describe: (e) => {
      const d = e.details ?? {};
      return `${actor(e)} applied ${d.applied ?? 0} and rejected ${d.rejected ?? 0} ZooKeeper change(s)${
        d.groupName ? ` for "${d.groupName}"` : ''
      }`;
    },
  },
  ZK_CHANGE_REJECTED: {
    label: 'ZK change rejected',
    category: 'ZooKeeper',
    outcome: 'removal',
    describe: (e) => {
      const d = e.details ?? {};
      return `${actor(e)} rejected ${plural(d.rejected ?? 0, 'ZooKeeper change')}${
        d.groupName ? ` for "${d.groupName}"` : ''
      }${quoteNote(d.reviewNote)}`;
    },
  },
  ZK_CHANGE_APPLY_FAILED: {
    label: 'ZK apply failed',
    category: 'ZooKeeper',
    outcome: 'failure',
    describe: (e) => {
      const d = e.details ?? {};
      return `Applying approved ZooKeeper changes failed (${d.failed ?? 0} of ${d.approved ?? 0})${
        d.groupName ? ` for "${d.groupName}"` : ''
      } (retryable)`;
    },
  },
  ZOOKEEPER_MIGRATION_TRIGGERED: {
    label: 'ZK migration',
    category: 'ZooKeeper',
    outcome: 'neutral',
    describe: (e) => `${actor(e)} triggered the ZooKeeper ACL/namespace migration`,
  },

  // Sync & system ----------------------------------------------------------------------
  MANUAL_SYNC_TRIGGERED: {
    label: 'Platform sync',
    category: 'Sync & system',
    outcome: 'success',
    describe: (e) => {
      const d = e.details ?? {};
      return `${actor(e)} synced ${d.platform ?? 'platform'} cache: ${plural(d.usersSynced ?? 0, 'user')}, ${plural(
        d.groupsSynced ?? 0,
        'group',
      )}`;
    },
  },
  REDASH_RESYNC_TRIGGERED: {
    label: 'Redash resync',
    category: 'Sync & system',
    outcome: 'neutral',
    describe: (e) => `${actor(e)} triggered a full Redash membership resync`,
  },
  REDASH_QA_RESYNC_TRIGGERED: {
    label: 'Redash QA resync',
    category: 'Sync & system',
    outcome: 'neutral',
    describe: (e) => `${actor(e)} triggered a full Redash QA membership resync`,
  },
  REDASH_IMPORT_TRIGGERED: {
    label: 'Redash import',
    category: 'Sync & system',
    outcome: 'neutral',
    describe: (e) => {
      const d = e.details ?? {};
      const mode = d.apply ? 'applied' : 'dry run';
      return `${actor(e)} ran a Redash import (${mode}): ${plural(d.grantsCreated ?? 0, 'grant')}, ${plural(
        d.accountRequestsCreated ?? 0,
        'account',
      )}, ${d.usersMatched ?? 0} matched`;
    },
  },
};

// ── public API ───────────────────────────────────────────────────────────────────────
const FALLBACK_LABEL = (action: string): string => {
  const words = action.toLowerCase().split('_');
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const fallbackOutcome = (action: string): AuditOutcome => {
  if (action.includes('FAILED')) return 'failure';
  if (action.includes('PARTIAL')) return 'partial';
  if (action.includes('REJECT') || action.includes('REVOKE') || action.includes('DELETE') || action.includes('DISABLED'))
    return 'removal';
  if (action.includes('GRANT') || action.includes('APPROV') || action.includes('CREATED') || action.includes('APPLIED'))
    return 'success';
  return 'neutral';
};

export const auditLabel = (action: string): string => CATALOG[action]?.label ?? FALLBACK_LABEL(action);

export const auditCategory = (action: string): AuditCategory => CATALOG[action]?.category ?? 'Sync & system';

export const auditOutcome = (action: string): AuditOutcome =>
  CATALOG[action]?.outcome ?? fallbackOutcome(action);

/** True when the event was produced by a background job, not a human action. */
export const isSystemActor = (e: AuditLogEntry): boolean =>
  e.performerName?.startsWith('system') || e.performerId?.startsWith('system');

/** The one-line plain-English summary for the table + modal header. */
export const describeAuditEntry = (e: AuditLogEntry, groupName?: string | null): string => {
  const group = groupName ?? e.details?.groupName ?? null;
  const cat = CATALOG[e.action];
  if (cat) {
    try {
      return cat.describe(e, group);
    } catch {
      // A malformed details payload must never blank a log row — fall through.
    }
  }
  const t = e.targetUserName ? ` — ${nm(e.targetUserName)}` : '';
  return `${auditLabel(e.action)}${t}${group ? ` (${group})` : ''}`;
};

/** Filter dropdown options, grouped by category, in catalog order. */
export const auditActionGroups = (): { category: AuditCategory; actions: { value: string; label: string }[] }[] => {
  const byCat = new Map<AuditCategory, { value: string; label: string }[]>();
  for (const [action, cat] of Object.entries(CATALOG)) {
    const list = byCat.get(cat.category) ?? [];
    list.push({ value: action, label: cat.label });
    byCat.set(cat.category, list);
  }
  return [...byCat.entries()].map(([category, actions]) => ({ category, actions }));
};

/** Outcome → badge colors, mapped onto the app's status CSS variables. */
export const outcomeBadgeStyle = (outcome: AuditOutcome): { backgroundColor: string; color: string } => {
  switch (outcome) {
    case 'success':
      return { backgroundColor: 'var(--status-approved-bg)', color: 'var(--status-approved-text)' };
    case 'failure':
    case 'removal':
      return { backgroundColor: 'var(--status-rejected-bg)', color: 'var(--status-rejected-text)' };
    case 'partial':
      return { backgroundColor: 'var(--status-pending-bg)', color: 'var(--status-pending-text)' };
    default:
      return { backgroundColor: 'var(--primary-light)', color: 'var(--primary)' };
  }
};

/** Back-compat shim: colored badge style keyed off the raw action string. */
export const actionBadgeStyle = (action: string): { backgroundColor: string; color: string } =>
  outcomeBadgeStyle(auditOutcome(action));
