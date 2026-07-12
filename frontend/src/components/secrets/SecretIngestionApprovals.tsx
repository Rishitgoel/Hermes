import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import SectionHeader from '../common/SectionHeader';
import { queryKeys } from '../../lib/queryKeys';
import { envBg, envOf, formatTargetPath, INFRA_STATE_META } from '../../lib/infraTargetFormat';
import { useToast } from '../../contexts/ToastContext';
import {
  listIngestionRequests,
  listSecretsInstances,
  reviewIngestionRequest,
  type SecretIngestionEntry,
} from '../../services/api/secretsApi';

/** ADD = key doesn't exist yet. UPDATE = key exists with a different value. UNCHANGED = key exists with the same value already. */
const entryKind = (entry: SecretIngestionEntry): 'ADD' | 'UPDATE' | 'UNCHANGED' => {
  if (entry.previousValue === null || entry.previousValue === undefined) return 'ADD';
  return entry.previousValue === entry.value ? 'UNCHANGED' : 'UPDATE';
};

const KIND_STYLES: Record<'ADD' | 'UPDATE' | 'UNCHANGED', { bg: string; color: string }> = {
  ADD: { bg: '#16a34a', color: '#fff' },
  UPDATE: { bg: '#d97706', color: '#fff' },
  UNCHANGED: { bg: 'var(--border)', color: 'var(--text-muted)' },
};

const AcceptReject: React.FC<{
  decision: 'APPROVED' | 'REJECTED' | undefined;
  onChange: (d: 'APPROVED' | 'REJECTED') => void;
}> = ({ decision, onChange }) => (
  <div style={{ display: 'inline-flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)', flexShrink: 0 }}>
    <button
      type="button"
      onClick={() => onChange('APPROVED')}
      title="Approve this entry"
      style={{
        border: 'none',
        padding: '3px 8px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        background: decision === 'APPROVED' ? '#16a34a' : 'transparent',
        color: decision === 'APPROVED' ? '#fff' : 'var(--text-muted)',
      }}
    >
      <Icons.Check size={13} />
    </button>
    <button
      type="button"
      onClick={() => onChange('REJECTED')}
      title="Reject this entry"
      style={{
        border: 'none',
        padding: '3px 8px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        background: decision === 'REJECTED' ? '#dc2626' : 'transparent',
        color: decision === 'REJECTED' ? '#fff' : 'var(--text-muted)',
      }}
    >
      <Icons.X size={13} />
    </button>
  </div>
);

export const SecretIngestionApprovals: React.FC = () => {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [decisions, setDecisions] = useState<Record<string, Record<string, 'APPROVED' | 'REJECTED'>>>({});

  // The review queue merges every configured instance (prod + sandbox), so each row carries its
  // own `platform`; look up the instances to badge which AWS account a request targets.
  const { data: instances = [] } = useQuery({
    queryKey: queryKeys.secretsInstances(),
    queryFn: listSecretsInstances,
  });
  const instanceLabel = (platform: string): string =>
    instances.find((i) => i.key === platform)?.label ?? platform;
  const multiInstance = instances.length > 1;

  const { data: requests = [], isLoading } = useQuery({
    queryKey: queryKeys.secretIngestionRequests('review'),
    queryFn: () => listIngestionRequests('review'),
    refetchInterval: 15000,
    refetchOnMount: 'always',
  });

  // No default: an entry with no explicit decision is neither approved nor
  // rejected yet — every key must be reviewed (individually, or via Approve
  // all / Reject all) before a request can be submitted.
  const decisionFor = (reqId: string, keyName: string): 'APPROVED' | 'REJECTED' | undefined =>
    decisions[reqId]?.[keyName];

  const setDecision = (reqId: string, keyName: string, value: 'APPROVED' | 'REJECTED') =>
    setDecisions((prev) => ({
      ...prev,
      [reqId]: { ...prev[reqId], [keyName]: value },
    }));

  const setAll = (reqId: string, keys: string[], value: 'APPROVED' | 'REJECTED') =>
    setDecisions((prev) => ({
      ...prev,
      [reqId]: Object.fromEntries(keys.map((k) => [k, value])),
    }));

  const reviewMutation = useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: { decisions: { key: string; decision: 'APPROVED' | 'REJECTED' }[]; note?: string };
    }) => reviewIngestionRequest(id, payload),
    onSuccess: (data) => {
      toast.success(`Review applied — request ${data.status.replace(/_/g, ' ').toLowerCase()}.`);
      queryClient.invalidateQueries({ queryKey: queryKeys.secretIngestionRequests('review') });
    },
    onError: (err: any) => toast.error(err?.message || 'Failed to review request.'),
  });

  const handleSubmit = (reqId: string, entries: SecretIngestionEntry[]) => {
    const decided = entries.map((entry) => ({ key: entry.key, decision: decisionFor(reqId, entry.key) }));
    if (decided.some((d) => d.decision === undefined)) {
      toast.error('Review every entry (Approve or Reject) before applying.');
      return;
    }
    reviewMutation.mutate({
      id: reqId,
      payload: {
        decisions: decided as { key: string; decision: 'APPROVED' | 'REJECTED' }[],
        note: notes[reqId]?.trim() || undefined,
      },
    });
  };

  if (isLoading || requests.length === 0) return null;

  return (
    <div style={{ marginTop: 36 }}>
      <SectionHeader
        title="Secret Ingestion Requests"
        icon={<Icons.KeyRound size={18} />}
        meta={`${requests.length} pending`}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {requests.map((r) => {
          const busy = reviewMutation.isPending && reviewMutation.variables?.id === r.id;
          const entryKeys = r.entries.map((e) => e.key);
          // The keys a manifest PR is actually for — UPDATE-kind entries change a value in
          // AWS only and need no manifest edit, so they're excluded here on purpose.
          const newKeys = r.entries.filter((e) => entryKind(e) === 'ADD').map((e) => e.key);
          const decidedCount = r.entries.filter((e) => decisionFor(r.id, e.key) !== undefined).length;
          const approvedCount = r.entries.filter(
            (e) => decisionFor(r.id, e.key) === 'APPROVED'
          ).length;
          const allDecided = decidedCount === r.entries.length;

          return (
            <div key={r.id} className="table-container" style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>
                    AWS Secret
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '3px 0 7px', flexWrap: 'wrap' }}>
                    <Icons.KeyRound size={17} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                    <code style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-main)', wordBreak: 'break-all' }}>{r.secretName}</code>
                    {multiInstance && (
                      <span className="badge badge-sm" title="Which Secret Ingestion instance (AWS account) this request targets" style={{ fontSize: 10, fontWeight: 700, background: 'var(--bg-inset)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
                        {instanceLabel(r.platform)}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    Requested by <strong style={{ color: 'var(--text-main)', fontWeight: 600 }}>{r.requesterName.replace(/_/g, ' ')}</strong> ({r.requesterEmail})
                    {r.justification ? ` · "${r.justification}"` : ''}
                  </div>
                  {r.status === 'APPLY_FAILED' && (
                    <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#dc2626' }}>
                      <Icons.AlertTriangle size={13} style={{ flexShrink: 0 }} />
                      Previous apply failed{r.applyError ? ` — ${r.applyError}` : ''}. Re-review to retry.
                    </div>
                  )}

                  {/* Deployment PR — the manifests this ingestion will change, and a link to verify the diff */}
                  {(r.infraPrUrl || (r.infraTargets && r.infraTargets.length > 0) || r.infraSyncState) && (
                    <div style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', maxWidth: 560 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, padding: '7px 10px', background: 'var(--bg-card)', borderBottom: (r.infraTargets && r.infraTargets.length > 0) ? '1px solid var(--border)' : 'none' }}>
                        <Icons.GitPullRequestArrow size={14} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                        <span style={{ fontWeight: 600 }}>Deployment PR</span>
                        {r.infraSyncState && (() => {
                          const meta = INFRA_STATE_META[r.infraSyncState] ?? { label: r.infraSyncState, cls: 'badge-pending' };
                          return <span className={`badge ${meta.cls} badge-sm`} title={r.infraSyncNote ?? undefined}>{meta.label}</span>;
                        })()}
                        {r.infraTargets && r.infraTargets.some((t) => formatTargetPath(t.path).simulated) && (
                          <span className="badge badge-sm" style={{ fontSize: 9, fontWeight: 700, background: '#6b7280', color: '#fff' }}>SIMULATED</span>
                        )}
                        {r.infraPrUrl && (
                          <a href={r.infraPrUrl} target="_blank" rel="noopener noreferrer" className="btn btn-outline btn-sm" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, textDecoration: 'none' }}>
                            <Icons.ExternalLink size={12} />
                            Verify diff{r.infraPrNumber ? ` #${r.infraPrNumber}` : ''}
                          </a>
                        )}
                      </div>
                      {r.infraTargets && r.infraTargets.length > 0 && newKeys.length > 0 && (
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11, padding: '7px 10px', borderBottom: '1px solid var(--border)', background: 'rgba(22, 163, 74, 0.04)' }}>
                          <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontWeight: 600 }} title="Only new keys need a manifest change — an approved UPDATE just changes a value in AWS.">
                            Keys added:
                          </span>
                          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                            {newKeys.map((k) => {
                              const rejected = decisionFor(r.id, k) === 'REJECTED';
                              return (
                                <code
                                  key={k}
                                  title={rejected ? 'Rejected — will be dropped from the PR' : undefined}
                                  style={{
                                    background: 'var(--bg-card)',
                                    border: '1px solid var(--border)',
                                    borderRadius: 4,
                                    padding: '1px 6px',
                                    fontWeight: 600,
                                    opacity: rejected ? 0.5 : 1,
                                    textDecoration: rejected ? 'line-through' : 'none',
                                  }}
                                >
                                  {k}
                                </code>
                              );
                            })}
                          </span>
                        </div>
                      )}
                      {r.infraTargets && r.infraTargets.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px' }}>
                          {r.infraTargets.map((t) => {
                            // Prefer the backend-resolved env the requester actually saw
                            // (stored on the target); fall back to deriving it from the path
                            // for rows persisted before this field existed.
                            const env = t.env ?? envOf(t.path);
                            const { display } = formatTargetPath(t.path);
                            return (
                              <div key={t.path} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, flexWrap: 'wrap' }}>
                                <span className="badge badge-sm" style={{ textTransform: 'uppercase', fontSize: 9, fontWeight: 700, background: envBg(env), color: '#fff' }}>{env}</span>
                                <span className="badge badge-sm" style={{ fontSize: 9 }}>{t.format === 'spc' ? 'SPC' : 'values'}</span>
                                <code style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{display}</code>
                                {t.keys && t.keys.length > 0 && (
                                  <span style={{ fontSize: 9.5, color: 'var(--text-muted)', fontStyle: 'italic' }} title="The requester narrowed this file to only these keys">
                                    only: {t.keys.join(', ')}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setAll(r.id, entryKeys, 'APPROVED')}>
                    Approve all
                  </button>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setAll(r.id, entryKeys, 'REJECTED')}>
                    Reject all
                  </button>
                </div>
              </div>

              {/* Entries list with per-key accept/reject */}
              <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                <table className="hermes-table" style={{ margin: 0 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 100 }}>Action</th>
                      <th>Key</th>
                      <th>Value</th>
                      <th style={{ width: 120, textAlign: 'right' }}>Review Decision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.entries.map((entry) => {
                      const dec = decisionFor(r.id, entry.key);
                      const rejected = dec === 'REJECTED';
                      const kind = entryKind(entry);
                      const kindStyle = KIND_STYLES[kind];
                      return (
                        <tr
                          key={entry.key}
                          style={{
                            opacity: rejected ? 0.6 : 1,
                            backgroundColor: rejected ? 'rgba(220, 38, 38, 0.03)' : 'rgba(22, 163, 74, 0.02)',
                          }}
                        >
                          <td>
                            <span
                              className="badge badge-sm"
                              title={
                                kind === 'UPDATE'
                                  ? 'This key already exists — its value will be overwritten'
                                  : kind === 'UNCHANGED'
                                  ? 'This key already has this exact value'
                                  : 'This key does not exist yet'
                              }
                              style={{
                                textTransform: 'uppercase',
                                fontSize: 10,
                                fontWeight: 700,
                                background: kindStyle.bg,
                                color: kindStyle.color,
                              }}
                            >
                              {kind}
                            </span>
                          </td>
                          <td>
                            <code style={{ fontWeight: 600, fontSize: 12 }}>{entry.key}</code>
                          </td>
                          <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                            {entry.value === null || entry.value === undefined ? (
                              <span style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>(Redacted)</span>
                            ) : kind === 'UPDATE' ? (
                              <>
                                <span style={{ textDecoration: 'line-through', color: 'var(--text-muted)' }}>
                                  {entry.previousValue}
                                </span>
                                <span style={{ margin: '0 6px', color: 'var(--text-muted)' }}>→</span>
                                <span>{entry.value}</span>
                              </>
                            ) : (
                              entry.value
                            )}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <AcceptReject
                              decision={dec}
                              onChange={(val) => setDecision(r.id, entry.key, val)}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
                <input
                  className="form-input"
                  placeholder="Optional note for the requester…"
                  value={notes[r.id] ?? ''}
                  onChange={(e) => setNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                  style={{ flex: 1, height: 34 }}
                />
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy || !allDecided}
                  title={allDecided ? undefined : 'Review every entry (or use Approve all / Reject all) before applying'}
                  onClick={() => handleSubmit(r.id, r.entries)}
                >
                  {busy ? <Icons.Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Icons.Send size={14} />}
                  {allDecided
                    ? `Apply review (${approvedCount}✓ / ${r.entries.length - approvedCount}✗)`
                    : `Review all to apply (${decidedCount}/${r.entries.length} decided)`}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default SecretIngestionApprovals;
