import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import SectionHeader from '../common/SectionHeader';
import { queryKeys } from '../../lib/queryKeys';
import { useToast } from '../../contexts/ToastContext';
import {
  listZkChangeRequests,
  reviewZkChangeRequest,
  type ZkChange,
  type ZkChangeDecision,
  type ZkChangeRequest,
} from '../../services/api/zookeeperApi';
import { ACTION_COLOR, INDENT, ROW_TINT } from './zkFormat';
import { ActionBadge, ZkDiff, ZkRow } from './ZkRow';

// ── Change tree ─────────────────────────────────────────────────────────────────────
// The requested changes are laid out as a directory tree (the same shape the requester
// saw), so the reviewer evaluates them in context. Path segments that aren't themselves
// a change render as plain context folders; each actual change gets an accept/reject.
interface ChangeTreeNode {
  name: string;
  path: string;
  change?: ZkChange;
  children: Map<string, ChangeTreeNode>;
}

const buildChangeTree = (changes: ZkChange[]): ChangeTreeNode => {
  const root: ChangeTreeNode = { name: '', path: '', children: new Map() };
  for (const ch of changes) {
    const segs = ch.path.split('/').filter(Boolean);
    let cur = root;
    let acc = '';
    segs.forEach((seg, i) => {
      acc += `/${seg}`;
      if (!cur.children.has(seg)) cur.children.set(seg, { name: seg, path: acc, children: new Map() });
      cur = cur.children.get(seg)!;
      if (i === segs.length - 1) cur.change = ch;
    });
  }
  return root;
};

/** Per-change accept / reject toggle (git-style). */
const AcceptReject: React.FC<{ decision: ZkChangeDecision; onChange: (d: ZkChangeDecision) => void }> = ({ decision, onChange }) => (
  <div style={{ display: 'inline-flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)', flexShrink: 0 }}>
    <button
      type="button"
      onClick={() => onChange('APPROVED')}
      title="Approve this change"
      style={{ border: 'none', padding: '3px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', background: decision === 'APPROVED' ? '#16a34a' : 'transparent', color: decision === 'APPROVED' ? '#fff' : 'var(--text-muted)' }}
    >
      <Icons.Check size={13} />
    </button>
    <button
      type="button"
      onClick={() => onChange('REJECTED')}
      title="Reject this change"
      style={{ border: 'none', padding: '3px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', background: decision === 'REJECTED' ? '#dc2626' : 'transparent', color: decision === 'REJECTED' ? '#fff' : 'var(--text-muted)' }}
    >
      <Icons.X size={13} />
    </button>
  </div>
);

const ChangeNode: React.FC<{
  node: ChangeTreeNode;
  decisionFor: (path: string) => ZkChangeDecision;
  setDecision: (path: string, d: ZkChangeDecision) => void;
}> = ({ node, decisionFor, setDecision }) => {
  const change = node.change;
  const isFolder = node.children.size > 0;
  const decision = change ? decisionFor(change.path) : null;
  const rejected = decision === 'REJECTED';

  return (
    <div>
      <ZkRow
        icon={
          isFolder ? (
            <Icons.Folder size={16} style={{ color: change?.action === 'CREATE' ? ACTION_COLOR.CREATE : 'var(--primary)', flexShrink: 0 }} />
          ) : (
            <Icons.FileText size={16} style={{ color: change ? ACTION_COLOR[change.action] : 'var(--text-light)', flexShrink: 0 }} />
          )
        }
        name={node.name}
        badges={
          <>
            {change && <ActionBadge action={change.action} />}
            {change?.groupName && <span style={{ fontSize: 12, color: 'var(--text-light)', flexShrink: 0 }}>({change.groupName})</span>}
          </>
        }
        body={change && <ZkDiff change={change} />}
        actions={
          change &&
          (change.applied ? (
            <span
              className="badge badge-active badge-sm"
              style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}
              title="Applied in a previous attempt — cannot be changed"
            >
              <Icons.Check size={11} /> Applied
            </span>
          ) : (
            <AcceptReject decision={decision as ZkChangeDecision} onChange={(d) => setDecision(change.path, d)} />
          ))
        }
        tint={change ? ROW_TINT[change.action] : undefined}
        dim={rejected}
      />

      {isFolder && (
        <div style={{ marginLeft: INDENT, borderLeft: '1px solid var(--border)' }}>
          {[...node.children.values()].map((c) => (
            <ChangeNode key={c.path} node={c} decisionFor={decisionFor} setDecision={setDecision} />
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Pending ZooKeeper config-change requests the current user can review. Each request is
 * shown as the requester's directory tree, with the requested change at each node and an
 * accept/reject toggle on it (git-style). On apply, approved changes are written, the rest
 * rejected, and the request is closed. The server scopes the list to the reviewer (super →
 * all, ZK platform admin → all ZK groups, group admin → their ZK groups).
 */
const ZkChangeApprovals: React.FC = () => {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [notes, setNotes] = useState<Record<string, string>>({});
  // Per-request, per-change decision. Default (unset) = APPROVED.
  const [decisions, setDecisions] = useState<Record<string, Record<string, ZkChangeDecision>>>({});

  const { data: requests = [], isLoading } = useQuery({
    queryKey: queryKeys.zkChangeRequests('review'),
    queryFn: () => listZkChangeRequests('review'),
    refetchInterval: 15000,
    refetchOnMount: 'always',
  });

  // Defaults: a change already applied by a previous attempt (APPLY_FAILED retry) is
  // locked APPROVED (the backend enforces this too); a change the previous review
  // rejected defaults to REJECTED again; everything else defaults to APPROVED.
  const decisionFor = (r: ZkChangeRequest, path: string): ZkChangeDecision => {
    const change = r.changes.find((c) => c.path === path);
    if (change?.applied) return 'APPROVED';
    return decisions[r.id]?.[path] ?? (change?.decision === 'REJECTED' ? 'REJECTED' : 'APPROVED');
  };
  const setDecision = (reqId: string, path: string, value: ZkChangeDecision) =>
    setDecisions((prev) => ({ ...prev, [reqId]: { ...prev[reqId], [path]: value } }));
  const setAll = (reqId: string, paths: string[], value: ZkChangeDecision) =>
    setDecisions((prev) => ({ ...prev, [reqId]: Object.fromEntries(paths.map((p) => [p, value])) }));

  const reviewMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: { decisions: { path: string; decision: ZkChangeDecision }[]; note?: string } }) =>
      reviewZkChangeRequest(id, payload),
    onSuccess: (data) => {
      toast.success(`Review applied — request ${data.status.replace(/_/g, ' ').toLowerCase()}.`);
      queryClient.invalidateQueries({ queryKey: queryKeys.zkChangeRequests('review') });
    },
    onError: (err: any) => toast.error(err?.message || 'Failed to review change request.'),
  });

  const submit = (r: ZkChangeRequest) => {
    reviewMutation.mutate({
      id: r.id,
      payload: {
        decisions: r.changes.map((c) => ({ path: c.path, decision: decisionFor(r, c.path) })),
        note: notes[r.id]?.trim() || undefined,
      },
    });
  };

  if (isLoading || requests.length === 0) return null;

  return (
    <div style={{ marginTop: 36 }}>
      <SectionHeader title="ZooKeeper Config Requests" icon={<Icons.Network size={18} />} meta={`${requests.length} pending`} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {requests.map((r) => {
          const busy = reviewMutation.isPending && reviewMutation.variables?.id === r.id;
          const paths = r.changes.map((c) => c.path);
          const approvedCount = r.changes.filter((c) => decisionFor(r, c.path) === 'APPROVED').length;
          const tree = buildChangeTree(r.changes);
          return (
            <div key={r.id} className="table-container" style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>
                    {r.requesterName.replace(/_/g, ' ')}{' '}
                    <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 13 }}>({r.requesterEmail})</span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
                    {r.changes.length} change(s){r.justification ? ` · "${r.justification}"` : ''}
                  </div>
                  {r.status === 'APPLY_FAILED' && (
                    <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#dc2626' }}>
                      <Icons.AlertTriangle size={13} style={{ flexShrink: 0 }} />
                      Previous apply failed{r.applyError ? ` — ${r.applyError}` : ''}. Re-review to retry; already-applied changes are locked.
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setAll(r.id, paths, 'APPROVED')}>
                    Approve all
                  </button>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setAll(r.id, paths, 'REJECTED')}>
                    Reject all
                  </button>
                </div>
              </div>

              {/* Requested changes as a directory tree with per-change accept/reject */}
              <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                {[...tree.children.values()].map((n) => (
                  <ChangeNode key={n.path} node={n} decisionFor={(p) => decisionFor(r, p)} setDecision={(p, d) => setDecision(r.id, p, d)} />
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
                <input
                  className="form-input"
                  placeholder="Optional note for the requester…"
                  value={notes[r.id] ?? ''}
                  onChange={(e) => setNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                  style={{ flex: 1, height: 34 }}
                />
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => submit(r)}>
                  {busy ? <Icons.Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Icons.Send size={14} />}
                  Apply review ({approvedCount}✓ / {r.changes.length - approvedCount}✗)
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ZkChangeApprovals;
