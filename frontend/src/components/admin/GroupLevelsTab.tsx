import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { queryKeys } from '../../lib/queryKeys';
import { useToast } from '../../contexts/ToastContext';
import { prettyPlatform, slugify } from './adminUtils';
import { SkeletonRows } from '../common/Skeleton';
import ConfirmModal from './ConfirmModal';
import {
  listGroupLevels,
  createGroupLevel,
  updateGroupLevel,
  deleteGroupLevel,
  type ManageableGroup,
  type GroupLevelRow,
  type GroupLevelInput,
} from '../../services/api/admin';

const emptyLevelForm: GroupLevelInput = { name: '', slug: '', permission: '', externalGroupId: '', rank: 0 };

interface GroupLevelsTabProps {
  group: ManageableGroup;
}

export const GroupLevelsTab: React.FC<GroupLevelsTabProps> = ({ group }) => {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<GroupLevelRow | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<GroupLevelInput>(emptyLevelForm);
  // Auto-fill slug from name until the user types a slug by hand.
  const [slugTouched, setSlugTouched] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<GroupLevelRow | null>(null);

  const levelsQuery = useQuery({
    queryKey: queryKeys.adminGroupLevels(group.id),
    queryFn: () => listGroupLevels(group.id),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.adminGroupLevels(group.id) });
    // The request flow reads levels from the public group endpoints.
    queryClient.invalidateQueries({ queryKey: queryKeys.groups() });
    queryClient.invalidateQueries({ queryKey: queryKeys.groupDetail(group.slug) });
  };

  const resetForm = () => {
    setEditing(null);
    setShowForm(false);
    setForm(emptyLevelForm);
    setSlugTouched(false);
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const body: GroupLevelInput = {
        name: form.name.trim(),
        slug: form.slug.trim(),
        description: form.description?.trim() || undefined,
        permission: form.permission?.trim() || undefined,
        externalGroupId: form.externalGroupId?.trim() || undefined,
        rank: form.rank ?? 0,
      };
      return editing ? updateGroupLevel(group.id, editing.id, body) : createGroupLevel(group.id, body);
    },
    onSuccess: () => {
      toast.success(editing ? 'Level updated.' : 'Level created.');
      resetForm();
      invalidate();
    },
    onError: (e: any) => toast.error(e.message || 'Failed to save level.'),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: (lvl: GroupLevelRow) => updateGroupLevel(group.id, lvl.id, { isActive: !lvl.isActive }),
    onSuccess: () => {
      toast.success('Level updated.');
      invalidate();
    },
    onError: (e: any) => toast.error(e.message || 'Failed to update level.'),
  });

  const deleteMutation = useMutation({
    mutationFn: (lvl: GroupLevelRow) => deleteGroupLevel(group.id, lvl.id),
    onSuccess: (result) => {
      if (result.deleted) {
        toast.success('Level removed.');
      } else if ((result.activeMembers ?? 0) > 0) {
        toast.success(
          `Level kept active members (${result.activeMembers}), so it was deactivated instead of removed — they keep access until expiry/revoke.`,
          { duration: 8000 },
        );
      } else {
        toast.success(
          `Level has ${result.openRequests ?? 0} in-flight request(s), so it was deactivated instead of removed. Resolve those requests, then remove it.`,
          { duration: 8000 },
        );
      }
      setConfirmDelete(null);
      invalidate();
    },
    onError: (e: any) => toast.error(e.message || 'Failed to remove level.'),
  });

  const startCreate = () => {
    setEditing(null);
    setForm(emptyLevelForm);
    setSlugTouched(false);
    setShowForm(true);
  };

  const startEdit = (lvl: GroupLevelRow) => {
    setEditing(lvl);
    setForm({
      name: lvl.name,
      slug: lvl.slug,
      description: lvl.description ?? '',
      permission: lvl.permission ?? '',
      externalGroupId: lvl.externalGroupId ?? '',
      rank: lvl.rank,
    });
    setSlugTouched(true);
    setShowForm(true);
  };

  const levels = levelsQuery.data ?? [];
  const canSave = form.name.trim().length > 0 && /^[a-z0-9-]+$/.test(form.slug.trim());

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
        <div className="admin-section-label">Permission Levels</div>
        {!showForm && (
          <button type="button" className="btn btn-outline btn-sm" onClick={startCreate}>
            <Icons.Plus size={13} /> Add level
          </button>
        )}
      </div>

      <p style={{ fontSize: '12px', color: 'var(--text-light)', marginBottom: '10px', lineHeight: 1.4 }}>
        Each level is backed by its own {prettyPlatform(group.platform)} group. Leave the External Group ID blank and Hermes creates that group for you; then configure read-only vs write on it in {prettyPlatform(group.platform)}. Hermes routes requesters to the level they pick.
      </p>

      {levelsQuery.isLoading ? (
        <SkeletonRows count={2} />
      ) : levels.length === 0 ? (
        <div style={{ color: 'var(--text-light)', fontSize: '13px', marginBottom: '10px' }}>
          No levels. This group is requested directly (no level selection).
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' }}>
          {levels.map((lvl) => (
            <div key={lvl.id} className="admin-row" style={{ opacity: lvl.isActive ? 1 : 0.6 }}>
              <Icons.Layers size={15} style={{ color: lvl.isActive ? 'var(--primary)' : 'var(--text-light)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  {lvl.name}
                  {lvl.permission && (
                    <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '1px 6px' }}>
                      {lvl.permission}
                    </span>
                  )}
                  {!lvl.isActive && <span className="badge badge-neutral badge-sm">INACTIVE</span>}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                  ext id: {lvl.externalGroupId || '—'} · rank {lvl.rank} · {lvl.memberCount} member{lvl.memberCount === 1 ? '' : 's'}
                </div>
              </div>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => startEdit(lvl)}>
                Edit
              </button>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                disabled={toggleActiveMutation.isPending}
                onClick={() => toggleActiveMutation.mutate(lvl)}
              >
                {lvl.isActive ? 'Deactivate' : 'Activate'}
              </button>
              <button
                type="button"
                className="btn btn-outline btn-danger-outline btn-sm"
                disabled={deleteMutation.isPending}
                onClick={() => setConfirmDelete(lvl)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '12px', background: 'var(--bg-card)' }}>
          <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '10px' }}>
            {editing ? `Edit level: ${editing.name}` : 'New level'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Name</label>
              <input
                className="form-input"
                value={form.name}
                placeholder="Senior Dev"
                onChange={(e) => {
                  const name = e.target.value;
                  setForm((f) => ({ ...f, name, slug: slugTouched ? f.slug : slugify(name) }));
                }}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Slug</label>
              <input
                className="form-input"
                value={form.slug}
                placeholder="senior-dev"
                onChange={(e) => {
                  setSlugTouched(true);
                  setForm((f) => ({ ...f, slug: e.target.value }));
                }}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Permission label</label>
              <input
                className="form-input"
                value={form.permission ?? ''}
                placeholder="write / read-only"
                onChange={(e) => setForm((f) => ({ ...f, permission: e.target.value }))}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">External Group ID ({prettyPlatform(group.platform)}) — optional</label>
              <input
                className="form-input"
                value={form.externalGroupId ?? ''}
                placeholder={editing ? '1043' : 'leave blank to auto-create'}
                onChange={(e) => setForm((f) => ({ ...f, externalGroupId: e.target.value }))}
              />
              {!editing && (
                <div style={{ fontSize: '11px', color: 'var(--text-light)', marginTop: '4px', lineHeight: 1.4 }}>
                  Blank → Hermes creates a new {prettyPlatform(group.platform)} group. Paste an ID to link an existing one.
                </div>
              )}
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Rank (higher = more senior)</label>
              <input
                type="number"
                min={0}
                className="form-input"
                value={form.rank ?? 0}
                onChange={(e) => setForm((f) => ({ ...f, rank: Number(e.target.value) }))}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0, gridColumn: '1 / -1' }}>
              <label className="form-label">Description (optional)</label>
              <input
                className="form-input"
                value={form.description ?? ''}
                placeholder="What this level can do"
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
          </div>
          {!/^[a-z0-9-]*$/.test(form.slug) && (
            <div style={{ fontSize: '11px', color: 'var(--status-rejected-text)', marginTop: '6px' }}>
              Slug must be lowercase alphanumeric with hyphens.
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' }}>
            <button type="button" className="btn btn-outline btn-sm" onClick={resetForm} disabled={saveMutation.isPending}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!canSave || saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create level'}
            </button>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={!!confirmDelete}
        title="Remove level"
        danger
        confirmLabel="Remove"
        loading={deleteMutation.isPending}
        message={
          confirmDelete
            ? confirmDelete.memberCount > 0
              ? `"${confirmDelete.name}" has ${confirmDelete.memberCount} active member(s). It will be deactivated (not deleted) so they keep access until expiry/revoke. Continue?`
              : `Remove level "${confirmDelete.name}"?`
            : ''
        }
        onConfirm={() => confirmDelete && deleteMutation.mutate(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
};

export default GroupLevelsTab;
