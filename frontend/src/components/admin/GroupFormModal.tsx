import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Modal from '../common/Modal';
import { queryKeys } from '../../lib/queryKeys';
import { prettyPlatform, slugify } from './adminUtils';
import {
  createGroup,
  updateGroup,
  type ManageableGroup,
  type CreateGroupInput,
  type UpdateGroupInput,
  type GroupRecord,
} from '../../services/api/admin';

/**
 * Create or edit a group. The form is intentionally minimal: Name + Platform +
 * (optional) backing external group id on create; Name + Description on edit. The
 * slug is auto-derived from the name (never asked) and description is optional.
 * Icon / colour are derived for display (see groupIconName), so they aren't edited
 * here. On edit, slug/platform/externalGroupId are locked (immutable; see admin
 * controller).
 */
interface GroupFormModalProps {
  mode: 'create' | 'edit';
  platforms: string[];
  defaultPlatform?: string | null;
  group?: ManageableGroup;
  onClose: () => void;
  onSaved: (message: string, group: GroupRecord) => void;
  onError: (message: string) => void;
}

export const GroupFormModal: React.FC<GroupFormModalProps> = ({
  mode,
  platforms,
  defaultPlatform,
  group,
  onClose,
  onSaved,
  onError,
}) => {
  const queryClient = useQueryClient();
  const isEdit = mode === 'edit';

  const [name, setName] = useState(group?.name ?? '');
  const [platform, setPlatform] = useState(group?.platform ?? defaultPlatform ?? platforms[0] ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [externalGroupId, setExternalGroupId] = useState('');

  // Slug is never asked — it's derived from the name on create (immutable after).
  const derivedSlug = slugify(name);

  const saveMutation = useMutation({
    mutationFn: (): Promise<GroupRecord> => {
      if (isEdit && group) {
        const body: UpdateGroupInput = {
          name: name.trim(),
          description: description.trim(),
        };
        return updateGroup(group.id, body);
      }
      const body: CreateGroupInput = {
        name: name.trim(),
        slug: derivedSlug,
        description: description.trim() || undefined,
        platform,
        externalGroupId: externalGroupId.trim() || undefined,
      };
      return createGroup(body);
    },
    onSuccess: (record) => {
      const p = isEdit ? group!.platform : platform;
      queryClient.invalidateQueries({ queryKey: queryKeys.adminGroups(p) });
      queryClient.invalidateQueries({ queryKey: queryKeys.groups() });
      if (isEdit && group) {
        queryClient.invalidateQueries({ queryKey: queryKeys.groupDetail(group.slug) });
      }
      onSaved(isEdit ? `Group "${record.name}" updated.` : `Group "${record.name}" created.`, record);
    },
    onError: (e: any) => onError(e?.message || 'Failed to save group.'),
  });

  // On create the name must yield a valid (non-empty) slug; on edit only the name matters.
  const canSave =
    name.trim().length > 0 && (isEdit || (derivedSlug.length > 0 && platform.length > 0));

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isEdit ? `Edit group: ${group?.name}` : 'New group'}
      footer={
        <>
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={saveMutation.isPending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSave || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create group'}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Name</label>
          <input
            className="form-input"
            value={name}
            placeholder="Credit Card"
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          {!isEdit && derivedSlug && (
            <div style={{ fontSize: '11px', color: 'var(--text-light)', marginTop: '4px' }}>
              Slug: <code>{derivedSlug}</code> (auto-generated; a number is appended if
              it's already taken, then fixed after creation)
            </div>
          )}
        </div>

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Platform</label>
          <select className="form-select" value={platform} disabled={isEdit} onChange={(e) => setPlatform(e.target.value)}>
            {platforms.map((p) => (
              <option key={p} value={p}>
                {prettyPlatform(p)}
              </option>
            ))}
          </select>
          {isEdit && (
            <div style={{ fontSize: '11px', color: 'var(--text-light)', marginTop: '4px' }}>
              Platform can't be changed after creation.
            </div>
          )}
        </div>

        {!isEdit && (
          <div className="form-group" style={{ marginBottom: 0, gridColumn: '1 / -1' }}>
            <label className="form-label">External Group ID — optional</label>
            <input
              className="form-input"
              value={externalGroupId}
              placeholder="blank → auto-create"
              onChange={(e) => setExternalGroupId(e.target.value)}
            />
            <div style={{ fontSize: '11px', color: 'var(--text-light)', marginTop: '4px', lineHeight: 1.4 }}>
              Blank → Hermes creates a new {platform ? prettyPlatform(platform) : 'platform'} group. Paste an ID to link an existing one.
            </div>
          </div>
        )}

        <div className="form-group" style={{ marginBottom: 0, gridColumn: '1 / -1' }}>
          <label className="form-label">Description — optional</label>
          <input
            className="form-input"
            value={description}
            placeholder="What data / tables this group grants access to"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>

      {!isEdit && name.trim() && !derivedSlug && (
        <div style={{ fontSize: '11px', color: 'var(--status-rejected-text)', marginTop: '8px' }}>
          Name must contain letters or numbers to generate a slug.
        </div>
      )}
    </Modal>
  );
};

export default GroupFormModal;
