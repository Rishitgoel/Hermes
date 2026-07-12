import React, { useState } from 'react';
import { Copy, Check, ChevronDown, ChevronRight } from 'lucide-react';
import { Modal } from '../common/Modal';
import { ActionBadge, ZkDiff } from '../zookeeper/ZkRow';
import { detectType, previewValue } from '../zookeeper/zkFormat';
import { TypeChip } from '../zookeeper/TypeChip';
import type { ZkChange } from '../../services/api/zookeeperApi';
import {
  AuditLogEntry,
  actionBadgeStyle,
  auditLabel,
  describeAuditEntry,
  REQUEST_FLOW_ACTIONS,
  requestParticipants,
} from '../../lib/auditFormat';

interface AuditDetailModalProps {
  entry: AuditLogEntry | null;
  /** Resolved group name for entry.groupId, if the caller has it (e.g. from the filter dropdown). */
  groupName?: string | null;
  onClose: () => void;
}

const formatFullDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

// details keys are camelCase field names ("fromLevelName") — split on capitals for a label.
const humanize = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();

const Empty: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <em style={{ color: 'var(--text-light)', fontWeight: 400 }}>{children ?? '—'}</em>
);

const DetailItem: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="detail-item">
    <span className="detail-label">{label}</span>
    <span className="detail-value" style={{ fontWeight: 600 }}>
      {children}
    </span>
  </div>
);

const DetailGrid: React.FC<{ rows: { label: string; value: React.ReactNode }[] }> = ({ rows }) => (
  <div className="detail-card" style={{ padding: 20 }}>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      {rows.map((r) => (
        <DetailItem key={r.label} label={r.label}>
          {r.value}
        </DetailItem>
      ))}
    </div>
  </div>
);

// ── Generic fallback: renders any details object as labeled key/value pairs so every
// action is meaningfully clickable even without a bespoke layout below. ────────────────
const GenericValue: React.FC<{ value: any }> = ({ value }) => {
  if (value === null || value === undefined || value === '') return <Empty />;
  if (Array.isArray(value)) {
    if (value.length === 0) return <Empty>none</Empty>;
    const primitives = value.every((v) => v === null || typeof v !== 'object');
    if (primitives) {
      return (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {value.map((v, i) => (
            <span key={i} className="badge badge-sm badge-neutral">
              {String(v)}
            </span>
          ))}
        </span>
      );
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {value.map((v, i) => (
          <div key={i} style={{ paddingLeft: 12, borderLeft: '2px solid var(--border)' }}>
            <GenericObject value={v} />
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === 'object') return <GenericObject value={value} />;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  return <span style={{ wordBreak: 'break-word' }}>{String(value)}</span>;
};

const GenericObject: React.FC<{ value: Record<string, any> }> = ({ value }) => {
  const entries = Object.entries(value ?? {}).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return <Empty>empty</Empty>;
  return (
    <div className="detail-list" style={{ gap: 10 }}>
      {entries.map(([k, v]) => (
        <DetailItem key={k} label={humanize(k)}>
          <GenericValue value={v} />
        </DetailItem>
      ))}
    </div>
  );
};

// ── ZK_CHANGE_* — path-level diff cards, reusing the same ZkDiff/ActionBadge the
// requester + approver trees already render, so this modal is pixel-consistent with them. ──
const ZkChangeCard: React.FC<{ change: ZkChange; isSubmission: boolean }> = ({ change, isSubmission }) => {
  const oldPreview = previewValue(change.oldValue ?? null);
  const newPreview = previewValue(change.newValue ?? null);
  const longValue = oldPreview.length > 80 || newPreview.length > 80;

  return (
    <div className="detail-card" style={{ padding: 16, gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <code style={{ fontSize: 13, fontWeight: 600 }}>{change.path}</code>
        <ActionBadge action={change.action} />
        {!isSubmission && change.decision && (
          <span className={`badge badge-sm ${change.decision === 'APPROVED' ? 'badge-approved' : 'badge-rejected'}`}>
            {change.decision}
          </span>
        )}
        {!isSubmission && change.decision === 'APPROVED' && (
          <span className={`badge badge-sm ${change.applied ? 'badge-approved' : 'badge-rejected'}`}>
            {change.applied ? 'Applied' : 'Failed'}
          </span>
        )}
      </div>

      {!isSubmission && change.error && (
        <div style={{ color: 'var(--status-rejected-text)', fontSize: 12, fontWeight: 600 }}>{change.error}</div>
      )}

      <ZkDiff change={change} />

      {longValue && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            {change.oldValue != null && change.oldValue !== '' ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span className="detail-label">Old value</span>
                  <TypeChip type={detectType(change.oldValue)} />
                </div>
                <pre className="zk-value-block zk-value-block--old">{change.oldValue}</pre>
              </>
            ) : null}
          </div>
          <div>
            {change.newValue != null && change.newValue !== '' ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span className="detail-label">New value</span>
                  <TypeChip type={detectType(change.newValue)} />
                </div>
                <pre className="zk-value-block zk-value-block--new">{change.newValue}</pre>
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};

const ZkChangeBody: React.FC<{ entry: AuditLogEntry }> = ({ entry }) => {
  const d = entry.details ?? {};
  const isSubmission = entry.action === 'ZK_CHANGE_SUBMITTED';
  const changes: ZkChange[] = Array.isArray(d.changes) ? d.changes : [];

  const summaryRows: { label: string; value: React.ReactNode }[] = [];
  if (d.requestId) summaryRows.push({ label: 'Request ID', value: <code style={{ fontSize: 12 }}>{d.requestId}</code> });
  if (d.groupName) summaryRows.push({ label: 'Group', value: d.groupName });
  summaryRows.push({ label: 'Justification', value: d.justification || <Empty>none provided</Empty> });
  if (!isSubmission) {
    summaryRows.push({ label: 'Review note', value: d.reviewNote || <Empty>none</Empty> });
    summaryRows.push({
      label: 'Result',
      value: `${d.approved ?? 0} approved · ${d.applied ?? 0} applied · ${d.rejected ?? 0} rejected${d.failed ? ` · ${d.failed} failed` : ''}`,
    });
  } else {
    summaryRows.push({ label: 'Changes submitted', value: d.changeCount ?? changes.length });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <DetailGrid rows={summaryRows} />
      {changes.length === 0 ? (
        <p style={{ color: 'var(--text-light)', fontSize: 13 }}>
          This entry predates per-path change tracking — only summary counts are available. Newer entries record every
          changed path.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {changes.map((c, i) => (
            <ZkChangeCard key={`${c.path}-${i}`} change={c} isSubmission={isSubmission} />
          ))}
        </div>
      )}
    </div>
  );
};

// ── GROUP_PATHS_RECONCILED ──────────────────────────────────────────────────────────────
const PathListSection: React.FC<{ label: string; paths?: string[]; color: string }> = ({ label, paths, color }) => {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  return (
    <div>
      <span className="detail-label">
        {label} ({paths.length})
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
        {paths.map((p) => (
          <code
            key={p}
            style={{
              fontSize: 12,
              padding: '2px 8px',
              borderRadius: 6,
              backgroundColor: 'var(--bg-app)',
              border: `1px solid ${color}`,
              color,
            }}
          >
            {p}
          </code>
        ))}
      </div>
    </div>
  );
};

const GroupPathsReconciledBody: React.FC<{ details: any }> = ({ details: d }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    {(d.oldExternalGroupId || d.newExternalGroupId) && (
      <DetailGrid
        rows={[
          { label: 'Platform', value: d.platform ?? <Empty /> },
          { label: 'Old external group', value: d.oldExternalGroupId ?? <Empty /> },
          { label: 'New external group', value: d.newExternalGroupId ?? <Empty /> },
          { label: 'Members synced', value: d.memberCount ?? <Empty /> },
        ]}
      />
    )}
    <PathListSection label="Added paths" paths={d.addedPaths} color="var(--status-approved-text)" />
    <PathListSection label="Removed paths" paths={d.removedPaths} color="var(--status-rejected-text)" />
    <PathListSection label="Updated paths" paths={d.updatedPaths} color="var(--primary)" />
    {Array.isArray(d.memberSyncErrors) && d.memberSyncErrors.length > 0 && (
      <div>
        <span className="detail-label">Member sync errors ({d.memberSyncErrors.length})</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
          {d.memberSyncErrors.map((e: { member: string; error: string }, i: number) => (
            <div key={i} style={{ fontSize: 13, color: 'var(--status-rejected-text)' }}>
              <strong>{e.member}</strong>: {e.error}
            </div>
          ))}
        </div>
      </div>
    )}
  </div>
);

// ── Access workflow family ──────────────────────────────────────────────────────────────
const ACCESS_ACTIONS = new Set([
  'ACCESS_GRANTED',
  'ACCESS_REVOKED',
  'ACCESS_RENEWED',
  'ACCESS_LEVEL_CHANGED',
  'ACCESS_EXPIRED',
  'ACCESS_EXPIRY_FAILED',
  'ACCESS_QUEUED_FOR_SETUP',
  'ACCESS_BULK_REVOKED',
  'PROVISION_FAILED',
  'REQUEST_CREATED',
  'REQUEST_REJECTED',
  'ACCESS_IMPORTED',
]);

const AccessBody: React.FC<{ details: any }> = ({ details: d }) => {
  const rows: { label: string; value: React.ReactNode }[] = [];
  if (d.platform) rows.push({ label: 'Platform', value: d.platform });
  if (d.fromLevelName || d.toLevelName) {
    rows.push({ label: 'Level change', value: `${d.fromLevelName ?? 'none'} → ${d.toLevelName ?? 'none'}` });
  } else if (d.levelName) {
    rows.push({ label: 'Level', value: d.levelName });
  }
  if (d.duration) rows.push({ label: 'Duration', value: String(d.duration).replace(/_/g, ' ').toLowerCase() });
  if (d.expiresAt) rows.push({ label: 'Expires at', value: formatFullDate(d.expiresAt) });
  if (d.newExpiresAt) rows.push({ label: 'New expiry', value: formatFullDate(d.newExpiresAt) });
  if (d.renewal) rows.push({ label: 'Renewal', value: 'Yes' });
  if (d.reason) rows.push({ label: 'Reason', value: d.reason });
  if (d.justification) rows.push({ label: 'Justification', value: d.justification });
  if (d.note) rows.push({ label: 'Note', value: d.note });
  if (d.reviewNote) rows.push({ label: 'Review note', value: d.reviewNote });
  if (d.groupName) rows.push({ label: 'Group', value: d.groupName });
  if (d.externalUserId) rows.push({ label: 'External user ID', value: d.externalUserId });
  if (d.externalGroupId) rows.push({ label: 'External group ID', value: d.externalGroupId });
  if (d.oldExternalGroupId || d.newExternalGroupId) {
    rows.push({ label: 'External group', value: `${d.oldExternalGroupId ?? '—'} → ${d.newExternalGroupId ?? '—'}` });
  }
  if (d.source) rows.push({ label: 'Source', value: d.source });
  if (d.bulk || d.bulkId) rows.push({ label: 'Bulk operation', value: d.bulkId ?? 'Yes' });
  if (d.attempts != null) rows.push({ label: 'Retry attempts', value: d.attempts });
  if (d.platformMembershipAbsent) rows.push({ label: 'Platform membership', value: 'Already absent' });
  if (d.orphanedPlatformMembership) rows.push({ label: 'Orphaned platform membership', value: 'Yes' });
  if (d.error) rows.push({ label: 'Error', value: <span style={{ color: 'var(--status-rejected-text)' }}>{d.error}</span> });
  if (d.oldDeprovisionError) {
    rows.push({ label: 'Old deprovision error', value: <span style={{ color: 'var(--status-rejected-text)' }}>{d.oldDeprovisionError}</span> });
  }

  if (rows.length === 0) return <GenericObject value={d} />;
  return <DetailGrid rows={rows} />;
};

// ── User creation family ────────────────────────────────────────────────────────────────
const USER_CREATION_ACTIONS = new Set([
  'USER_CREATION_RESUBMITTED',
  'USER_CREATION_REJECTED',
  'USER_CREATION_APPROVED',
  'USER_CREATION_COMPLETED',
]);

const UserCreationBody: React.FC<{ details: any }> = ({ details: d }) => {
  const rows: { label: string; value: React.ReactNode }[] = [];
  if (d.platform) rows.push({ label: 'Platform', value: d.platform });
  if (d.externalUserId) rows.push({ label: 'External user ID', value: d.externalUserId });
  if (d.justification) rows.push({ label: 'Justification', value: d.justification });
  if (d.note) rows.push({ label: 'Note', value: d.note });
  if (d.shortCircuited) rows.push({ label: 'Short-circuited', value: 'Yes (account already existed)' });

  if (rows.length === 0) return <GenericObject value={d} />;
  return <DetailGrid rows={rows} />;
};

// ── Group / level management family ─────────────────────────────────────────────────────
const GROUP_MGMT_ACTIONS = new Set([
  'GROUP_CREATED',
  'GROUP_UPDATED',
  'GROUP_ARCHIVED',
  'GROUP_DELETED',
  'GROUP_LEVEL_CREATED',
  'GROUP_LEVEL_UPDATED',
  'GROUP_LEVEL_DELETED',
  'GROUP_LEVEL_DEACTIVATED',
]);

const GroupMgmtBody: React.FC<{ details: any }> = ({ details: d }) => {
  const rows: { label: string; value: React.ReactNode }[] = [];
  if (d.name) rows.push({ label: 'Name', value: d.name });
  if (d.slug) rows.push({ label: 'Slug', value: d.slug });
  if (d.platform) rows.push({ label: 'Platform', value: d.platform });
  if (d.levelId) rows.push({ label: 'Level ID', value: <code style={{ fontSize: 12 }}>{d.levelId}</code> });
  if (d.externalGroupId) rows.push({ label: 'External group ID', value: d.externalGroupId });
  if (Array.isArray(d.changed) && d.changed.length > 0) rows.push({ label: 'Fields changed', value: d.changed.join(', ') });
  if (d.source) rows.push({ label: 'Source', value: d.source === 'platform-sync' ? 'Platform sync' : d.source });
  if (d.reason) rows.push({ label: 'Reason', value: d.reason });
  if (d.relinkedFrom || d.relinkedTo) rows.push({ label: 'Relinked', value: `${d.relinkedFrom ?? '—'} → ${d.relinkedTo ?? '—'}` });
  if (d.reactivated) rows.push({ label: 'Reactivated', value: 'Yes' });
  if (d.autoCreated) rows.push({ label: 'Auto-created', value: 'Yes' });
  if (d.forced) rows.push({ label: 'Forced (incl. history)', value: 'Yes' });

  if (rows.length === 0) return <GenericObject value={d} />;
  return <DetailGrid rows={rows} />;
};

const renderBody = (entry: AuditLogEntry): React.ReactNode => {
  const d = entry.details;
  if (!d) return <p style={{ color: 'var(--text-light)', fontSize: 13 }}>No additional details were recorded for this event.</p>;
  if (entry.action.startsWith('ZK_CHANGE_')) return <ZkChangeBody entry={entry} />;
  if (entry.action === 'GROUP_PATHS_RECONCILED') return <GroupPathsReconciledBody details={d} />;
  if (ACCESS_ACTIONS.has(entry.action)) return <AccessBody details={d} />;
  if (USER_CREATION_ACTIONS.has(entry.action)) return <UserCreationBody details={d} />;
  if (GROUP_MGMT_ACTIONS.has(entry.action)) return <GroupMgmtBody details={d} />;
  return <GenericObject value={d} />;
};

// ── Raw JSON fallback, always present so nothing is ever hidden ────────────────────────
const RawJsonAccordion: React.FC<{ details: any }> = ({ details }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(details ?? null, null, 2);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — JSON is still visible to select manually.
    }
  };

  return (
    <div>
      <button
        type="button"
        className="btn btn-outline btn-sm"
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Raw details
      </button>
      {open && (
        <div style={{ marginTop: 10, position: 'relative' }}>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={handleCopy}
            style={{ position: 'absolute', top: 8, right: 8, display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy JSON'}
          </button>
          <pre className="raw-json-block">{json}</pre>
        </div>
      )}
    </div>
  );
};

const ModalTitleBadge: React.FC<{ action: string }> = ({ action }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
    <span
      style={{
        fontSize: 14,
        fontWeight: 800,
        padding: '4px 10px',
        borderRadius: 'var(--radius-sm)',
        ...actionBadgeStyle(action),
      }}
    >
      {auditLabel(action)}
    </span>
    <code style={{ fontSize: 11, color: 'var(--text-light)', fontWeight: 600 }}>{action}</code>
  </span>
);

const formatPerformer = (name: string): React.ReactNode => {
  if (name.startsWith('system')) {
    return (
      <>
        {name.replace(/_/g, ' ')} <Empty>(system)</Empty>
      </>
    );
  }
  return name.replace(/_/g, ' ');
};

// Actions that are part of the request → review → provision lifecycle. For these the
// generic "Performer / Target user" labels are ambiguous, so the header instead names the
// two roles explicitly: who requested the access (maker) and who reviewed it (checker).
const cleanName = (n?: string | null): string | null => (n ? n.replace(/_/g, ' ') : null);

// Prefer the explicit names now stamped into details; fall back to the audit row's
// performer/target for historic entries that predate them (the checker performs a
// grant/reject, while on REQUEST_CREATED the performer IS the maker and there's no
// checker yet).
const deriveParticipants = (entry: AuditLogEntry): { maker: string | null; checker: React.ReactNode } => {
  const participants = requestParticipants(entry);
  const maker = cleanName(participants?.maker);
  const checkerName = cleanName(participants?.checker);
  return { maker, checker: checkerName ?? <Empty>Pending review</Empty> };
};

const HeaderCard: React.FC<{ entry: AuditLogEntry; groupName?: string | null }> = ({ entry, groupName }) => {
  const groupNode =
    entry.groupId || groupName ? groupName ?? entry.details?.groupName ?? entry.groupId : null;
  const requestIdItem = entry.accessRequestId ? (
    <DetailItem label="Access request ID">
      <code style={{ fontSize: 12 }}>{entry.accessRequestId}</code>
    </DetailItem>
  ) : null;

  if (REQUEST_FLOW_ACTIONS.has(entry.action)) {
    const { maker, checker } = deriveParticipants(entry);
    return (
      <div className="detail-card" style={{ padding: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <DetailItem label="Request maker">{maker ?? <Empty />}</DetailItem>
          <DetailItem label="Request checker">{checker}</DetailItem>
          <DetailItem label="Timestamp">{formatFullDate(entry.createdAt)}</DetailItem>
          {groupNode && <DetailItem label="Group">{groupNode}</DetailItem>}
          {requestIdItem}
          <DetailItem label="IP address">{entry.ipAddress ?? <Empty />}</DetailItem>
        </div>
      </div>
    );
  }

  return (
    <div className="detail-card" style={{ padding: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <DetailItem label="Performer">{formatPerformer(entry.performerName)}</DetailItem>
        <DetailItem label="Timestamp">{formatFullDate(entry.createdAt)}</DetailItem>
        <DetailItem label="Target user">
          {entry.targetUserName ? entry.targetUserName.replace(/_/g, ' ') : <Empty>System</Empty>}
        </DetailItem>
        <DetailItem label="IP address">{entry.ipAddress ?? <Empty />}</DetailItem>
        {groupNode && <DetailItem label="Group">{groupNode}</DetailItem>}
        {requestIdItem}
      </div>
    </div>
  );
};

export const AuditDetailModal: React.FC<AuditDetailModalProps> = ({ entry, groupName, onClose }) => {
  return (
    <Modal isOpen={!!entry} onClose={onClose} size="lg" title={entry ? <ModalTitleBadge action={entry.action} /> : ''}>
      {entry && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Plain-English one-liner first — the fastest read of what this event was. */}
          <p style={{ fontSize: 14, fontWeight: 600, margin: 0, lineHeight: 1.5 }}>
            {describeAuditEntry(entry, groupName)}
          </p>

          <HeaderCard entry={entry} groupName={groupName} />

          {renderBody(entry)}

          <RawJsonAccordion details={entry.details} />
        </div>
      )}
    </Modal>
  );
};

export default AuditDetailModal;
