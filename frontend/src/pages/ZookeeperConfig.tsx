import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import LoadingSpinner from '../components/common/LoadingSpinner';
import SectionHeader from '../components/common/SectionHeader';
import { useToast } from '../contexts/ToastContext';
import { queryKeys } from '../lib/queryKeys';
import {
  browseZkNode,
  getZkScope,
  listZkChangeRequests,
  submitZkChangeRequest,
  type ZkChange,
  type ZkChangeRequest,
} from '../services/api/zookeeperApi';
import { ACTION_COLOR, INDENT, ROW_TINT, ZK_ROW_FONT, detectType, parsesAsJson, previewValue, tooltipValue, isLargeValue } from '../components/zookeeper/zkFormat';
import { JsonViewerButton } from '../components/common/JsonValueViewer';
import { TypeChip } from '../components/zookeeper/TypeChip';
import { ActionBadge, ZkDiff, ZkRow } from '../components/zookeeper/ZkRow';

/**
 * Drafts are keyed by path — at most one pending change per znode. `kind` is a
 * frontend-only hint (stripped at submit) so a freshly-created empty node can be told
 * apart as a folder (expandable, nestable) vs a key/value leaf — ZooKeeper itself can't
 * distinguish them (both are just a childless znode).
 */
type Draft = ZkChange & { kind?: 'folder' | 'property' };
type DraftMap = Record<string, Draft>;

/** A node as the tree renders it (roots come from scope, children from a browse). */
interface TreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  value: string | null;
  canWrite: boolean;
}

const STATUS_BADGE: Record<ZkChangeRequest['status'], string> = {
  PENDING: 'badge-pending',
  APPLYING: 'badge-pending',
  APPLIED: 'badge-active',
  // Terminal-but-mixed — amber with a border, distinct from in-flight PENDING.
  PARTIALLY_APPLIED: 'badge-warning',
  APPLY_FAILED: 'badge-danger',
  REJECTED: 'badge-danger',
};

const DRAFTS_KEY = 'hermes_zk_drafts';

const isDirectChild = (base: string, p: string): boolean => {
  const prefix = base === '/' ? '/' : `${base}/`;
  if (!p.startsWith(prefix) || p === base) return false;
  return !p.slice(prefix.length).includes('/');
};

// ── Page ──────────────────────────────────────────────────────────────────────────
export const ZookeeperConfig: React.FC = () => {
  const queryClient = useQueryClient();
  const toast = useToast();

  // Drafts are mirrored to localStorage so switching tabs/pages never loses staged work.
  const [drafts, setDrafts] = useState<DraftMap>(() => {
    try {
      return JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}') as DraftMap;
    } catch {
      return {};
    }
  });
  const [justification, setJustification] = useState('');

  React.useEffect(() => {
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    } catch {
      /* quota / serialization — non-fatal */
    }
  }, [drafts]);

  // ── Queries ───────────────────────────────────────────────────────────────────
  const { data: scope = [], isLoading: scopeLoading } = useQuery({
    queryKey: queryKeys.zkScope(),
    queryFn: getZkScope,
  });

  const { data: myRequests = [] } = useQuery({
    queryKey: queryKeys.zkChangeRequests('mine'),
    queryFn: () => listZkChangeRequests('mine'),
  });

  // ── Mutations ─────────────────────────────────────────────────────────────────
  const submitMutation = useMutation({
    mutationFn: () =>
      submitZkChangeRequest({
        justification: justification.trim() || undefined,
        // Send only the change fields — the owning group is resolved server-side.
        changes: Object.values(drafts).map(({ path, action, oldValue, newValue }) => ({ path, action, oldValue, newValue })),
      }),
    onSuccess: () => {
      toast.success('Change request submitted for approval.');
      setDrafts({});
      setJustification('');
      queryClient.invalidateQueries({ queryKey: queryKeys.zkChangeRequests('mine') });
    },
    onError: (err: any) => toast.error(err?.message || 'Failed to submit change request.'),
  });

  // ── Derived ───────────────────────────────────────────────────────────────────
  const draftList = Object.values(drafts);

  // Distinct root paths per group.
  const groupsWithRoots = useMemo(() => {
    return scope
      .map((s) => {
        const pathMap = new Map<string, boolean>();
        for (const p of s.paths) {
          pathMap.set(p.path, (pathMap.get(p.path) || false) || p.canWrite);
        }
        const uniquePaths = [...pathMap.entries()]
          .map(([path, canWrite]) => ({ path, canWrite }))
          .sort((a, b) => a.path.localeCompare(b.path));
        return {
          groupId: s.groupId,
          groupName: s.groupName,
          paths: uniquePaths,
        };
      })
      .filter((g) => g.paths.length > 0)
      .sort((a, b) => a.groupName.localeCompare(b.groupName));
  }, [scope]);

  const stageDraft = (change: Draft) => setDrafts((prev) => ({ ...prev, [change.path]: change }));
  const removeDraft = (path: string) =>
    setDrafts((prev) => {
      const copy = { ...prev };
      delete copy[path];
      return copy;
    });
  // Remove a draft and every staged descendant (undoing a staged folder drops its children).
  const removeSubtree = (path: string) =>
    setDrafts((prev) => {
      const copy = { ...prev };
      const prefix = `${path}/`;
      for (const k of Object.keys(copy)) if (k === path || k.startsWith(prefix)) delete copy[k];
      return copy;
    });

  if (scopeLoading) return <LoadingSpinner />;

  return (
    <div>
      <SectionHeader
        title="ZooKeeper Configuration"
        icon={<Icons.Network size={18} />}
        meta="Read-only browse · all changes go through approval"
      />

      {/* Directory tree */}
      {groupsWithRoots.length === 0 ? (
        <div className="empty-state">
          <Icons.FolderTree size={40} className="empty-state-icon" />
          <p className="empty-state-desc">You don't have access to any ZooKeeper paths yet.</p>
        </div>
      ) : (
        <div className="table-container" style={{ padding: '12px 16px' }}>
          {groupsWithRoots.map((g) => (
            <div key={g.groupId} style={{ marginBottom: 24 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 8px',
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--text-muted)',
                  borderBottom: '1px solid var(--border)',
                  marginBottom: 12,
                }}
              >
                <Icons.Users size={14} style={{ color: 'var(--primary)' }} />
                <span>{g.groupName} Group</span>
              </div>
              <div style={{ paddingLeft: 8 }}>
                {g.paths.map((r) => (
                  <ZkTreeNode
                    key={r.path}
                    node={{ name: r.path, path: r.path, isFolder: true, value: null, canWrite: r.canWrite }}
                    isRoot
                    defaultExpanded
                    drafts={drafts}
                    stageDraft={stageDraft}
                    removeDraft={removeDraft}
                    removeSubtree={removeSubtree}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Draft cart + submission */}
      {draftList.length > 0 && (
        <div className="bulk-request-panel" style={{ marginTop: 28 }}>
          <div className="bulk-request-header">
            <div className="bulk-request-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icons.ListChecks size={18} style={{ color: 'var(--primary)' }} />
              {draftList.length} staged change(s)
            </div>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setDrafts({})}>
              Discard all
            </button>
          </div>

          <div style={{ padding: '0 4px' }}>
            {draftList.map((d) => (
              // One concise line per change: action · path · old→new · remove.
              <div key={d.path} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <ActionBadge action={d.action} />
                <code style={{ fontSize: ZK_ROW_FONT, color: 'var(--text-main)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flexShrink: 1 }}>
                  {d.path}
                </code>
                {/* Must be allowed to shrink — a large JSON value ellipsizes inside ZkDiff's
                    chips instead of pushing the row wider than the panel. */}
                <div style={{ flexShrink: 1, minWidth: 0 }}>
                  <ZkDiff change={d} />
                </div>
                <div style={{ flex: 1 }} />
                <button type="button" className="btn btn-outline btn-sm" onClick={() => removeDraft(d.path)} title="Remove" style={{ flexShrink: 0 }}>
                  <Icons.X size={13} />
                </button>
              </div>
            ))}
          </div>

          <div className="bulk-request-body" style={{ gridTemplateColumns: '1fr', gap: 12, marginTop: 12 }}>
            <div className="form-group form-row" style={{ marginBottom: 0 }}>
              <label className="form-label">Justification</label>
              <textarea
                className="form-textarea"
                placeholder="Why are these changes needed? (optional)"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
              />
            </div>
          </div>

          <div className="bulk-request-footer">
            <span style={{ marginRight: 'auto', fontSize: 13, color: 'var(--text-muted)' }}>
              Routed automatically to each path's group admins. Applies only after approval.
            </span>
            <button
              type="button"
              className="btn btn-primary"
              style={{ gap: 6 }}
              disabled={submitMutation.isPending}
              onClick={() => submitMutation.mutate()}
            >
              {submitMutation.isPending ? <Icons.Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> : <Icons.Send size={16} />}
              Submit for approval
            </button>
          </div>
        </div>
      )}

      {/* My change requests */}
      <div style={{ marginTop: 36 }}>
        <SectionHeader title="My Change Requests" icon={<Icons.FileClock size={18} />} meta={`${myRequests.length} total`} />
        {myRequests.length === 0 ? (
          <div className="empty-state">
            <Icons.FileClock size={40} className="empty-state-icon" />
            <p className="empty-state-desc">You haven't submitted any ZooKeeper config changes yet.</p>
          </div>
        ) : (
          <div className="table-container">
            <table className="hermes-table">
              <thead>
                <tr>
                  <th>Group</th>
                  <th>Changes</th>
                  <th style={{ width: 130 }}>Status</th>
                  <th style={{ width: 180 }}>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {myRequests.map((r) => {
                  const groupLabel = [...new Set(r.changes.map((c) => c.groupName).filter(Boolean))].join(', ') || '—';
                  return (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{groupLabel}</td>
                    <td>
                      <details>
                        <summary style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>{r.changes.length} change(s)</summary>
                        <div style={{ marginTop: 8 }}>
                          {r.changes.map((c, i) => (
                            <div key={i} style={{ fontSize: 12, padding: '2px 0', fontFamily: 'monospace', display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
                              {c.decision === 'APPROVED' && c.applied && <Icons.Check size={12} style={{ color: '#16a34a', flexShrink: 0 }} />}
                              {c.decision === 'APPROVED' && c.applied === false && <Icons.AlertTriangle size={12} style={{ color: '#dc2626', flexShrink: 0 }} />}
                              {c.decision === 'REJECTED' && <Icons.X size={12} style={{ color: '#dc2626', flexShrink: 0 }} />}
                              <span style={{ color: ACTION_COLOR[c.action], fontWeight: 700, flexShrink: 0 }}>{c.action}</span>
                              <span style={{ flexShrink: 0 }}>{c.path}</span>
                              {c.action !== 'DELETE' && c.action !== 'CLEAR' && (
                                // Large JSON values are one unbreakable token — shrink + ellipsize,
                                // full pretty-printed value on hover.
                                <span
                                  title={tooltipValue(c.newValue ?? null)}
                                  style={{ color: 'var(--text-muted)', minWidth: 0, flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                >
                                  → {previewValue(c.newValue ?? '')}
                                </span>
                              )}
                              {c.groupName && <span style={{ color: 'var(--text-light)', flexShrink: 0 }}>({c.groupName})</span>}
                              {c.error && <span style={{ color: '#dc2626' }}>· {c.error}</span>}
                            </div>
                          ))}
                          {r.applyError && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 4 }}>{r.applyError}</div>}
                        </div>
                      </details>
                    </td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[r.status]} badge-sm`}>{r.status}</span>
                    </td>
                    <td style={{ color: 'var(--text-light)', fontSize: 13 }}>
                      {new Date(r.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

// ── Tree node (recursive) ───────────────────────────────────────────────────────────
// Model: folder → folder → … → (key, value) leaf. Folders are pure containers (no value);
// only leaves hold a value. A node with no value can become a folder (Add buttons); a node
// with a value is a real key/value leaf. `virtual` = a staged-but-not-yet-created folder,
// so you can nest new nodes inside it before submitting. Indentation + the left guide line
// come from nested containers.
interface ZkTreeNodeProps {
  node: TreeNode;
  drafts: DraftMap;
  stageDraft: (c: Draft) => void;
  removeDraft: (path: string) => void;
  removeSubtree: (path: string) => void;
  isRoot?: boolean;
  defaultExpanded?: boolean;
  /** This node is a pending CREATE (folder) that doesn't exist on the server yet. */
  virtual?: boolean;
}

const rowsFor = (s: string) => Math.min(14, Math.max(2, s.split('\n').length));
const lastSeg = (p: string) => p.split('/').pop() || p;

const ZkTreeNode: React.FC<ZkTreeNodeProps> = ({ node, drafts, stageDraft, removeDraft, removeSubtree, isRoot, defaultExpanded, virtual }) => {
  const [expanded, setExpanded] = useState(!!defaultExpanded);
  const [editingValue, setEditingValue] = useState<string | null>(null); // inline value edit
  const [renameTo, setRenameTo] = useState<string | null>(null); // inline rename
  const [adding, setAdding] = useState<{ kind: 'property' | 'folder'; name: string; value: string } | null>(null);

  const browse = useQuery({
    queryKey: queryKeys.zkNodes(node.path),
    queryFn: () => browseZkNode(node.path),
    enabled: expanded && node.isFolder && !virtual,
  });

  const draft = drafts[node.path];
  const ownValue = virtual ? draft?.newValue ?? null : node.value ?? browse.data?.data ?? null;
  const canWrite = virtual ? true : browse.data?.canWrite ?? node.canWrite;

  const children = useMemo(() => browse.data?.children ?? [], [browse.data]);
  const serverChildPaths = useMemo(() => new Set(children.map((c) => c.path)), [children]);
  // Staged drafts that don't yet exist on the server (CREATE, or a new-path rename target).
  const stagedChildren = useMemo(
    () => Object.values(drafts).filter((d) => isDirectChild(node.path, d.path) && !serverChildPaths.has(d.path)),
    [drafts, node.path, serverChildPaths],
  );

  // A node acts as a folder if the server says so, it's a staged folder, or it has staged
  // children. Otherwise it's a leaf (key/value). An empty leaf can be turned into a folder.
  const isFolderView = node.isFolder || !!virtual || stagedChildren.length > 0;
  const isLeafView = !isFolderView;
  const isEmptyLeaf = isLeafView && (ownValue == null || ownValue === '');

  const toggle = () => isFolderView && setExpanded((e) => !e);
  const openAdd = (kind: 'property' | 'folder') => {
    setExpanded(true);
    setAdding({ kind, name: '', value: '' });
  };

  const startEdit = () => {
    if (ownValue && (detectType(ownValue) === 'json' || detectType(ownValue) === 'array')) {
      try {
        setEditingValue(JSON.stringify(JSON.parse(ownValue), null, 2));
        return;
      } catch {
        /* fall through to raw */
      }
    }
    setEditingValue(ownValue ?? '');
  };
  const confirmEdit = () => {
    if (editingValue === null) return;
    stageDraft({ path: node.path, action: 'SET', oldValue: ownValue, newValue: editingValue });
    setEditingValue(null);
  };
  const confirmRename = () => {
    const newName = (renameTo ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (newName) {
      const parent = node.path.slice(0, node.path.lastIndexOf('/')) || '';
      const newPath = `${parent}/${newName}`;
      if (newPath !== node.path) {
        stageDraft({ path: newPath, action: 'CREATE', oldValue: null, newValue: ownValue ?? '', kind: 'property' });
        stageDraft({ path: node.path, action: 'DELETE', oldValue: ownValue });
      }
    }
    setRenameTo(null);
  };
  const confirmAdd = () => {
    if (!adding) return;
    const name = adding.name.trim().replace(/^\/+|\/+$/g, '');
    if (name) {
      const base = node.path === '/' ? '' : node.path;
      stageDraft({
        path: `${base}/${name}`,
        action: 'CREATE',
        oldValue: null,
        newValue: adding.kind === 'folder' ? '' : adding.value,
        kind: adding.kind,
      });
    }
    setAdding(null);
  };

  const FolderIcon = expanded ? Icons.FolderOpen : Icons.Folder;
  const editingJsonInvalid =
    editingValue !== null && /^[[{]/.test(editingValue.trim()) && !parsesAsJson(editingValue);
  const addingJsonInvalid =
    !!adding && adding.kind === 'property' && /^[[{]/.test(adding.value.trim()) && !parsesAsJson(adding.value);

  const addButtons = (
    <>
      <button type="button" className="btn btn-outline btn-sm" onClick={() => openAdd('folder')} title="Add sub-folder">
        <Icons.FolderPlus size={13} />
      </button>
      <button type="button" className="btn btn-outline btn-sm" onClick={() => openAdd('property')} title="Add key / value">
        <Icons.FilePlus size={13} />
      </button>
    </>
  );

  // Caret / icon / name / value all flow through the shared <ZkRow> so this requester tree
  // and the admin review tree render a node identically. The editor (textarea) and rename
  // input are passed in as the row's body / name; everything else is the same on both sides.
  const caret = isFolderView ? (
    <button
      type="button"
      onClick={toggle}
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex', flexShrink: 0, marginTop: editingValue !== null ? 4 : 0 }}
    >
      {expanded ? <Icons.ChevronDown size={15} /> : <Icons.ChevronRight size={15} />}
    </button>
  ) : undefined;

  const icon = isRoot ? (
    <Icons.FolderTree size={16} style={{ color: 'var(--primary)', flexShrink: 0 }} />
  ) : isFolderView ? (
    <FolderIcon size={16} style={{ color: virtual ? ACTION_COLOR.CREATE : 'var(--primary)', flexShrink: 0 }} />
  ) : (
    <Icons.FileText size={16} style={{ color: 'var(--text-light)', flexShrink: 0, marginTop: editingValue !== null ? 3 : 0 }} />
  );

  const nameNode =
    renameTo !== null ? (
      <input
        className="form-input"
        value={renameTo}
        autoFocus
        onChange={(e) => setRenameTo(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') confirmRename();
          if (e.key === 'Escape') setRenameTo(null);
        }}
        style={{ height: 28, width: 180, flexShrink: 0 }}
      />
    ) : (
      node.name
    );

  const badges = (
    <>
      {!canWrite && <Icons.Lock size={11} style={{ color: 'var(--text-light)', flexShrink: 0 }} />}
      {draft && <ActionBadge action={draft.action} />}
    </>
  );

  const editingBody = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }}>
      <textarea
        className="form-textarea"
        value={editingValue ?? ''}
        autoFocus
        rows={rowsFor(editingValue ?? '')}
        onChange={(e) => setEditingValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) confirmEdit();
          if (e.key === 'Escape') setEditingValue(null);
        }}
        style={{ fontFamily: 'monospace', fontSize: ZK_ROW_FONT, minHeight: 0, width: '100%' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <TypeChip type={detectType(editingValue ?? '')} />
        <button type="button" className="btn btn-primary btn-sm" onClick={confirmEdit} title="Stage value change (Ctrl/Cmd+Enter)">
          <Icons.Check size={13} /> Stage
        </button>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setEditingValue(null)} title="Cancel (Esc)">
          <Icons.X size={13} />
        </button>
        {editingValue !== null && parsesAsJson(editingValue) && (
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => setEditingValue(JSON.stringify(JSON.parse(editingValue), null, 2))}
            title="Beautify JSON"
          >
            <Icons.Sparkles size={13} /> Beautify
          </button>
        )}
        {editingJsonInvalid && <span style={{ fontSize: 12, color: ACTION_COLOR.DELETE }}>invalid JSON (will be stored as a string)</span>}
      </div>
    </div>
  );

  // Current value for a plain (un-staged) leaf — folders show nothing, staged nodes show a diff.
  // No type chip on the read view; the inferred type is only surfaced while editing (below).
  // A large value (JSON / multi-line / long) ellipsizes here and gets an expand-to-viewer button.
  const leafValue = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%' }}>
      <span
        title={ownValue ? tooltipValue(ownValue) : undefined}
        style={{
          fontFamily: 'monospace',
          fontSize: ZK_ROW_FONT,
          color: 'var(--text-muted)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {ownValue ? previewValue(ownValue) : <em style={{ color: 'var(--text-light)' }}>—</em>}
      </span>
      {isLargeValue(ownValue) && (
        <JsonViewerButton title={node.path} sections={[{ label: 'Value', value: ownValue, tone: 'neutral' }]} />
      )}
    </span>
  );

  const body =
    editingValue !== null ? editingBody : draft ? <ZkDiff change={draft} /> : isLeafView ? leafValue : null;

  const rowActions =
    editingValue === null && renameTo === null ? (
      <div style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }}>
        {virtual ? (
          <>
            {addButtons}
            <button type="button" className="btn btn-outline btn-sm" onClick={() => removeSubtree(node.path)} title="Undo (removes this folder and anything staged inside it)">
              <Icons.Undo2 size={13} /> Undo
            </button>
          </>
        ) : draft ? (
          <button type="button" className="btn btn-outline btn-sm" onClick={() => removeDraft(node.path)} title="Undo staged change">
            <Icons.Undo2 size={13} /> Undo
          </button>
        ) : canWrite ? (
          isFolderView ? (
            <>
              {addButtons}
              {!isRoot && (
                <button type="button" className="btn btn-outline btn-danger-outline btn-sm" onClick={() => stageDraft({ path: node.path, action: 'DELETE', oldValue: ownValue })} title="Delete folder">
                  <Icons.Trash2 size={13} />
                </button>
              )}
            </>
          ) : (
            <>
              <button type="button" className="btn btn-outline btn-sm" onClick={startEdit} title="Edit value">
                <Icons.Pencil size={13} />
              </button>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setRenameTo(node.name)} title="Rename (stages create + delete)">
                <Icons.TextCursorInput size={13} />
              </button>
              {isEmptyLeaf ? (
                addButtons
              ) : (
                <button type="button" className="btn btn-outline btn-sm" onClick={() => stageDraft({ path: node.path, action: 'CLEAR', oldValue: ownValue, newValue: '' })} title="Clear value (keep node)">
                  <Icons.Eraser size={13} />
                </button>
              )}
              {!isRoot && (
                <button type="button" className="btn btn-outline btn-danger-outline btn-sm" onClick={() => stageDraft({ path: node.path, action: 'DELETE', oldValue: ownValue })} title="Delete node">
                  <Icons.Trash2 size={13} />
                </button>
              )}
            </>
          )
        ) : (
          <span style={{ color: 'var(--text-light)', fontSize: 12 }}>read-only</span>
        )}
      </div>
    ) : undefined;

  return (
    <div>
      <ZkRow
        caret={caret}
        icon={icon}
        name={nameNode}
        nameTitle={node.path}
        onNameClick={isFolderView ? toggle : undefined}
        badges={badges}
        body={body}
        actions={rowActions}
        tint={draft ? ROW_TINT[draft.action] : undefined}
        align={editingValue !== null ? 'flex-start' : 'center'}
      />

      {/* Children + staged + add-input — nested container draws the indent guide line */}
      {expanded && (isFolderView || adding) && (
        <div style={{ marginLeft: INDENT, borderLeft: '1px solid var(--border)' }}>
          {/* inline add-child input — laid out like the leaf row it will become.
              A folder is a single-line name (Enter stages it). A property gets a
              multi-line value editor (so JSON spans rows): Enter inserts a newline,
              Ctrl/Cmd+Enter stages, with a live type chip + Beautify. */}
          {adding && (adding.kind === 'folder' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px 5px 8px', borderRadius: 6, background: '#f0fdf4' }}>
              <span style={{ width: 15, display: 'inline-block' }} />
              <Icons.Folder size={16} style={{ color: ACTION_COLOR.CREATE, flexShrink: 0 }} />
              <input
                className="form-input"
                placeholder="folder name"
                value={adding.name}
                autoFocus
                onChange={(e) => setAdding({ ...adding, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmAdd();
                  if (e.key === 'Escape') setAdding(null);
                }}
                style={{ height: 28, width: 150, flexShrink: 0, fontWeight: 600 }}
              />
              <button type="button" className="btn btn-primary btn-sm" onClick={confirmAdd} disabled={!adding.name.trim()} title="Stage create" style={{ flexShrink: 0 }}>
                <Icons.Check size={13} />
              </button>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setAdding(null)} title="Cancel" style={{ flexShrink: 0 }}>
                <Icons.X size={13} />
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 12px 8px 8px', borderRadius: 6, background: '#f0fdf4' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 15, display: 'inline-block' }} />
                <Icons.FileText size={16} style={{ color: ACTION_COLOR.CREATE, flexShrink: 0 }} />
                <input
                  className="form-input"
                  placeholder="key"
                  value={adding.name}
                  autoFocus
                  onChange={(e) => setAdding({ ...adding, name: e.target.value })}
                  onKeyDown={(e) => {
                    // Enter does NOT stage here — the value below may be multi-line JSON.
                    if (e.key === 'Escape') setAdding(null);
                  }}
                  style={{ height: 28, width: 200, flexShrink: 0, fontWeight: 600 }}
                />
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setAdding(null)} title="Cancel" style={{ marginLeft: 'auto', flexShrink: 0 }}>
                  <Icons.X size={13} />
                </button>
              </div>
              <textarea
                className="form-textarea"
                placeholder={'value — number, boolean, JSON object/array, or "quoted string"'}
                value={adding.value}
                rows={rowsFor(adding.value)}
                onChange={(e) => setAdding({ ...adding, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) confirmAdd();
                  if (e.key === 'Escape') setAdding(null);
                }}
                style={{ fontFamily: 'monospace', fontSize: ZK_ROW_FONT, minHeight: 0, width: '100%' }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <TypeChip type={detectType(adding.value)} />
                <button type="button" className="btn btn-primary btn-sm" onClick={confirmAdd} disabled={!adding.name.trim()} title="Stage create (Ctrl/Cmd+Enter)">
                  <Icons.Check size={13} /> Stage
                </button>
                {parsesAsJson(adding.value) && (
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => setAdding({ ...adding, value: JSON.stringify(JSON.parse(adding.value), null, 2) })}
                    title="Beautify JSON"
                  >
                    <Icons.Sparkles size={13} /> Beautify
                  </button>
                )}
                {addingJsonInvalid && <span style={{ fontSize: 12, color: ACTION_COLOR.DELETE }}>invalid JSON (will be stored as a string)</span>}
              </div>
            </div>
          ))}

          {browse.isLoading ? (
            <div style={{ padding: '6px 12px 6px 8px' }}>
              <Icons.Loader size={14} style={{ animation: 'spin 1s linear infinite', color: 'var(--text-light)' }} />
            </div>
          ) : browse.isError ? (
            <div style={{ padding: '6px 12px 6px 8px', fontSize: 12, color: ACTION_COLOR.DELETE }}>
              {(browse.error as any)?.message || 'Could not load this path.'}
            </div>
          ) : (
            <>
              {children.map((c) => (
                <ZkTreeNode
                  key={c.path}
                  node={{ name: c.name, path: c.path, isFolder: c.isFolder, value: c.value, canWrite: c.canWrite }}
                  drafts={drafts}
                  stageDraft={stageDraft}
                  removeDraft={removeDraft}
                  removeSubtree={removeSubtree}
                />
              ))}

              {/* staged children (not yet on server) */}
              {stagedChildren.map((d) => {
                const childIsFolder = d.kind === 'folder' || Object.keys(drafts).some((k) => k.startsWith(`${d.path}/`));
                // A staged folder is rendered as a real, expandable virtual node so it can be nested into.
                if (childIsFolder) {
                  return (
                    <ZkTreeNode
                      key={d.path}
                      node={{ name: lastSeg(d.path), path: d.path, isFolder: false, value: null, canWrite: true }}
                      virtual
                      defaultExpanded
                      drafts={drafts}
                      stageDraft={stageDraft}
                      removeDraft={removeDraft}
                      removeSubtree={removeSubtree}
                    />
                  );
                }
                // A staged key/value (or delete/clear of a not-yet-known node) — same row as everywhere.
                return (
                  <ZkRow
                    key={d.path}
                    icon={<Icons.FileText size={16} style={{ color: ACTION_COLOR.CREATE, flexShrink: 0 }} />}
                    name={lastSeg(d.path)}
                    badges={<ActionBadge action={d.action} />}
                    body={<ZkDiff change={d} />}
                    actions={
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => removeDraft(d.path)} title="Undo" style={{ flexShrink: 0 }}>
                        <Icons.Undo2 size={13} /> Undo
                      </button>
                    }
                    tint={ROW_TINT[d.action]}
                  />
                );
              })}

              {children.length === 0 && stagedChildren.length === 0 && !adding && (
                <div style={{ padding: '5px 12px 5px 8px', fontSize: 12, color: 'var(--text-light)', fontStyle: 'italic' }}>empty</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default ZookeeperConfig;
