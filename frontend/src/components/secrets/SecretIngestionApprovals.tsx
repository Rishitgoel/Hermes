import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import SectionHeader from '../common/SectionHeader';
import { queryKeys } from '../../lib/queryKeys';
import { useToast } from '../../contexts/ToastContext';
import {
  listIngestionRequests,
  reviewIngestionRequest,
  type SecretIngestionEntry,
} from '../../services/api/secretsApi';

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
          const decidedCount = r.entries.filter((e) => decisionFor(r.id, e.key) !== undefined).length;
          const approvedCount = r.entries.filter(
            (e) => decisionFor(r.id, e.key) === 'APPROVED'
          ).length;
          const allDecided = decidedCount === r.entries.length;

          return (
            <div key={r.id} className="table-container" style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>
                    {r.requesterName.replace(/_/g, ' ')}{' '}
                    <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 13 }}>
                      ({r.requesterEmail})
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
                    Requested ingestion for AWS Secret: <code style={{ fontWeight: 600 }}>{r.secretName}</code>
                    {r.justification ? ` · "${r.justification}"` : ''}
                  </div>
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
                              className="badge badge-pending badge-sm"
                              style={{ textTransform: 'uppercase', fontSize: 10, fontWeight: 700 }}
                            >
                              ADD
                            </span>
                          </td>
                          <td>
                            <code style={{ fontWeight: 600, fontSize: 12 }}>{entry.key}</code>
                          </td>
                          <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                            {entry.value === null || entry.value === undefined ? (
                              <span style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>(Redacted)</span>
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
