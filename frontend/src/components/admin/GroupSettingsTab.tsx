import React, { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { queryKeys } from '../../lib/queryKeys';
import { useToast } from '../../contexts/ToastContext';
import { prettyPlatform, reconcileToast } from './adminUtils';
import ConfirmModal from './ConfirmModal';
import GroupFormModal from './GroupFormModal';
import { updateGroup, deleteGroup, type ManageableGroup } from '../../services/api/admin';

interface GroupSettingsTabProps {
  group: ManageableGroup;
  /** Called after a permanent delete so the drawer can close. */
  onDeleted: () => void;
}

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', gap: '12px', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
    <div style={{ width: '140px', flexShrink: 0, fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>{label}</div>
    <div style={{ fontSize: '13px', color: 'var(--text-main)', wordBreak: 'break-word' }}>{children}</div>
  </div>
);

export const GroupSettingsTab: React.FC<GroupSettingsTabProps> = ({ group, onDeleted }) => {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [showEdit, setShowEdit] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmForceDelete, setConfirmForceDelete] = useState(false);

  // Hard delete (incl. history) is only allowed when nobody currently holds active
  // access — otherwise the backend rejects it. memberCount is the active-grant count.
  const hasActiveMembers = group.memberCount > 0;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.adminGroups(group.platform) });
    queryClient.invalidateQueries({ queryKey: queryKeys.groups() });
    queryClient.invalidateQueries({ queryKey: queryKeys.groupDetail(group.slug) });
  };

  const archiveMutation = useMutation({
    mutationFn: (next: boolean) => updateGroup(group.id, { isActive: next }),
    onSuccess: (_r, next) => {
      toast.success(next ? 'Group restored — visible in the request flow again.' : 'Group archived — hidden from new requests. Existing members keep access.', { duration: 8000 });
      refresh();
      setConfirmArchive(false);
    },
    onError: (e: any) => toast.error(e.message || 'Failed to update group.'),
  });

  // ZooKeeper groups map to a newline-separated list of znode paths, editable here.
  // Saving reconciles existing members onto the new mapping (server-side).
  const isZk = group.platform === 'zookeeper';
  const [pathsDraft, setPathsDraft] = useState(group.externalGroupId ?? '');
  // Resync the draft when the canonical value changes — after a save refetch or a
  // concurrent admin's edit — so the textarea never shows a stale value or a spurious
  // dirty state. Edits made before any refetch are preserved (the prop is unchanged then).
  useEffect(() => {
    setPathsDraft(group.externalGroupId ?? '');
  }, [group.externalGroupId]);
  const pathsDirty = pathsDraft.trim() !== (group.externalGroupId ?? '').trim();

  const pathsMutation = useMutation({
    mutationFn: () => updateGroup(group.id, { externalGroupId: pathsDraft.trim() }),
    onSuccess: (res) => {
      const { ok, message } = reconcileToast(res.reconciliation);
      if (ok) {
        toast.success(message, { duration: 8000 });
      } else {
        toast.error(message, { duration: 9000 });
      }
      refresh();
    },
    onError: (e: any) => toast.error(e.message || 'Failed to save paths.'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteGroup(group.id),
    onSuccess: (result) => {
      if (result.deleted) {
        toast.success(`Group "${group.name}" permanently deleted.`);
        refresh();
        onDeleted();
      } else {
        toast.success(
          `Group has history (${result.accessCount ?? 0} access record(s), ${result.requestCount ?? 0} request(s)), so it was archived instead of deleted.`,
          { duration: 8000 },
        );
        refresh();
        setConfirmDelete(false);
      }
    },
    onError: (e: any) => toast.error(e.message || 'Failed to delete group.'),
  });

  // Permanent delete including history (force) — backend gates on no active members.
  const forceDeleteMutation = useMutation({
    mutationFn: () => deleteGroup(group.id, true),
    onSuccess: () => {
      toast.success(`Group "${group.name}" permanently deleted, including its history.`);
      refresh();
      setConfirmForceDelete(false);
      onDeleted();
    },
    onError: (e: any) => toast.error(e.message || 'Failed to delete group.'),
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div className="admin-section-label">Group Details</div>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowEdit(true)}>
          <Icons.Pencil size={14} /> Edit details
        </button>
      </div>

      <div style={{ marginBottom: '20px' }}>
        <Row label="Name">{group.name}</Row>
        <Row label="Description">{group.description || '—'}</Row>
        <Row label="Platform">{prettyPlatform(group.platform)}</Row>
        <Row label="Slug">{group.slug}</Row>
        {!isZk && <Row label="External Group ID">{group.externalGroupId || '—'}</Row>}
        <Row label="Tables">{group.tables.length ? group.tables.join(', ') : '—'}</Row>
        <Row label="Status">
          {group.isActive ? (
            <span style={{ color: 'var(--status-approved-text)', fontWeight: 700 }}>Active</span>
          ) : (
            <span style={{ color: 'var(--text-light)', fontWeight: 700 }}>Archived</span>
          )}
        </Row>
      </div>

      {/* ZooKeeper: editable multi-path mapping. Each line is one znode path with
          optional #perms; saving reconciles current members onto the new set. */}
      {isZk && (
        <div style={{ marginBottom: '20px' }}>
          <div className="admin-section-label" style={{ marginBottom: '6px' }}>ZooKeeper Paths</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4, marginBottom: '8px' }}>
            One znode path per line, optional <code>#perms</code> (c/d/r/w/a) — e.g.{' '}
            <code>/hermes/credit-card#cdrw</code>. Saving grants new paths to every current member and
            removes any you drop.
          </div>
          <textarea
            value={pathsDraft}
            onChange={(e) => setPathsDraft(e.target.value)}
            rows={Math.max(3, pathsDraft.split('\n').length + 1)}
            spellCheck={false}
            placeholder={'/hermes/credit-card#cdrw\n/hermes/shared-config#r'}
            style={{
              width: '100%',
              fontFamily: 'monospace',
              fontSize: '12px',
              padding: '8px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border)',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!pathsDirty || pathsMutation.isPending || pathsDraft.trim().length === 0}
              onClick={() => pathsMutation.mutate()}
            >
              {pathsMutation.isPending ? 'Saving…' : 'Save paths'}
            </button>
          </div>
        </div>
      )}

      {/* Danger zone: archive/restore + permanent delete */}
      <div style={{ border: '1px solid var(--status-rejected-text)', borderRadius: 'var(--radius-md)', padding: '14px', background: 'var(--status-rejected-bg)' }}>
        <div className="admin-section-label" style={{ color: 'var(--status-rejected-text)', marginBottom: '8px' }}>Danger Zone</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
              {group.isActive
                ? 'Archiving hides this group from new requests. Existing members keep access until expiry/revoke.'
                : 'This group is archived. Restore it to make it requestable again.'}
            </div>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              style={{ flexShrink: 0 }}
              disabled={archiveMutation.isPending}
              onClick={() => (group.isActive ? setConfirmArchive(true) : archiveMutation.mutate(true))}
            >
              {group.isActive ? 'Archive group' : 'Restore group'}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
              Permanently delete. Only possible if the group has never had a member or request; otherwise it archives.
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              style={{ flexShrink: 0, color: 'white', background: 'var(--status-rejected-text)', borderColor: 'var(--status-rejected-text)' }}
              disabled={deleteMutation.isPending}
              onClick={() => setConfirmDelete(true)}
            >
              Delete permanently
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
              Permanently delete <strong>including its history</strong> (access + request records).
              {hasActiveMembers
                ? ` Blocked: ${group.memberCount} active member(s) — revoke their access first.`
                : ' Audit log entries are kept. This cannot be undone.'}
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              style={{ flexShrink: 0, color: 'white', background: 'var(--status-rejected-text)', borderColor: 'var(--status-rejected-text)' }}
              disabled={forceDeleteMutation.isPending || hasActiveMembers}
              title={hasActiveMembers ? 'Revoke all active members before deleting.' : undefined}
              onClick={() => setConfirmForceDelete(true)}
            >
              Delete with history
            </button>
          </div>
        </div>
      </div>

      {showEdit && (
        <GroupFormModal
          mode="edit"
          platforms={[group.platform]}
          group={group}
          onClose={() => setShowEdit(false)}
          onSaved={(msg) => {
            toast.success(msg);
            setShowEdit(false);
          }}
          onError={(msg) => toast.error(msg)}
        />
      )}

      <ConfirmModal
        isOpen={confirmArchive}
        title="Archive group"
        confirmLabel="Archive"
        loading={archiveMutation.isPending}
        message={`Archive "${group.name}"? It will be hidden from new access requests. Existing members keep their access until it expires or is revoked.`}
        onConfirm={() => archiveMutation.mutate(false)}
        onClose={() => setConfirmArchive(false)}
      />

      <ConfirmModal
        isOpen={confirmDelete}
        title="Delete group permanently"
        danger
        confirmLabel="Delete"
        loading={deleteMutation.isPending}
        message={`Permanently delete "${group.name}" and its backing platform group? If the group has any history (members or requests, past or present) it will be archived instead. This cannot be undone.`}
        onConfirm={() => deleteMutation.mutate()}
        onClose={() => setConfirmDelete(false)}
      />

      <ConfirmModal
        isOpen={confirmForceDelete}
        title="Delete group with history"
        danger
        confirmLabel="Delete with history"
        loading={forceDeleteMutation.isPending}
        message={`Permanently delete "${group.name}", its backing platform group, and ALL of its access + request history? This is only allowed because no one currently holds active access. Audit log entries are preserved. This cannot be undone.`}
        onConfirm={() => forceDeleteMutation.mutate()}
        onClose={() => setConfirmForceDelete(false)}
      />
    </div>
  );
};

export default GroupSettingsTab;
