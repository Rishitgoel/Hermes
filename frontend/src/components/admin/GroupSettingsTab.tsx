import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { queryKeys } from '../../lib/queryKeys';
import { prettyPlatform } from './adminUtils';
import ConfirmModal from './ConfirmModal';
import GroupFormModal from './GroupFormModal';
import { updateGroup, deleteGroup, type ManageableGroup } from '../../services/api/admin';

type Banner = { type: 'success' | 'error'; text: string };

interface GroupSettingsTabProps {
  group: ManageableGroup;
  onBanner: (b: Banner) => void;
  /** Called after a permanent delete so the drawer can close. */
  onDeleted: () => void;
}

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', gap: '12px', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
    <div style={{ width: '140px', flexShrink: 0, fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>{label}</div>
    <div style={{ fontSize: '13px', color: 'var(--text-main)', wordBreak: 'break-word' }}>{children}</div>
  </div>
);

export const GroupSettingsTab: React.FC<GroupSettingsTabProps> = ({ group, onBanner, onDeleted }) => {
  const queryClient = useQueryClient();
  const [showEdit, setShowEdit] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.adminGroups(group.platform) });
    queryClient.invalidateQueries({ queryKey: queryKeys.groups() });
    queryClient.invalidateQueries({ queryKey: queryKeys.groupDetail(group.slug) });
  };

  const archiveMutation = useMutation({
    mutationFn: (next: boolean) => updateGroup(group.id, { isActive: next }),
    onSuccess: (_r, next) => {
      onBanner({ type: 'success', text: next ? 'Group restored — visible in the request flow again.' : 'Group archived — hidden from new requests. Existing members keep access.' });
      refresh();
      setConfirmArchive(false);
    },
    onError: (e: any) => onBanner({ type: 'error', text: e.message || 'Failed to update group.' }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteGroup(group.id),
    onSuccess: (result) => {
      if (result.deleted) {
        onBanner({ type: 'success', text: `Group "${group.name}" permanently deleted.` });
        refresh();
        onDeleted();
      } else {
        onBanner({
          type: 'success',
          text: `Group has history (${result.accessCount ?? 0} access record(s), ${result.requestCount ?? 0} request(s)), so it was archived instead of deleted.`,
        });
        refresh();
        setConfirmDelete(false);
      }
    },
    onError: (e: any) => onBanner({ type: 'error', text: e.message || 'Failed to delete group.' }),
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div className="admin-section-label">Group Details</div>
        <button type="button" className="btn btn-outline" style={{ padding: '5px 12px', fontSize: '12px' }} onClick={() => setShowEdit(true)}>
          <Icons.Pencil size={14} /> Edit details
        </button>
      </div>

      <div style={{ marginBottom: '20px' }}>
        <Row label="Name">{group.name}</Row>
        <Row label="Description">{group.description || '—'}</Row>
        <Row label="Platform">{prettyPlatform(group.platform)}</Row>
        <Row label="Slug">{group.slug}</Row>
        <Row label="External Group ID">{group.externalGroupId || '—'}</Row>
        <Row label="Tables">{group.tables.length ? group.tables.join(', ') : '—'}</Row>
        <Row label="Status">
          {group.isActive ? (
            <span style={{ color: 'var(--status-approved-text)', fontWeight: 700 }}>Active</span>
          ) : (
            <span style={{ color: 'var(--text-light)', fontWeight: 700 }}>Archived</span>
          )}
        </Row>
      </div>

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
              className="btn btn-outline"
              style={{ flexShrink: 0, padding: '6px 12px', fontSize: '12px' }}
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
              className="btn btn-primary btn-danger"
              style={{ flexShrink: 0, padding: '6px 12px', fontSize: '12px', background: 'var(--status-rejected-text)', borderColor: 'var(--status-rejected-text)' }}
              disabled={deleteMutation.isPending}
              onClick={() => setConfirmDelete(true)}
            >
              Delete permanently
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
            onBanner({ type: 'success', text: msg });
            setShowEdit(false);
          }}
          onError={(msg) => onBanner({ type: 'error', text: msg })}
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
    </div>
  );
};

export default GroupSettingsTab;
