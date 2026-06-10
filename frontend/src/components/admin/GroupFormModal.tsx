import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
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
 * Create or edit a group. On create the admin picks the platform and (optionally) a
 * backing external group id — blank auto-creates one via the platform adapter. On
 * edit, slug/platform/externalGroupId are locked (immutable; see admin controller).
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

const DEFAULT_COLOR = '#6366f1';

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
  const [slug, setSlug] = useState(group?.slug ?? '');
  // On edit the slug is fixed, so treat it as "touched" (don't auto-rewrite).
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [platform, setPlatform] = useState(group?.platform ?? defaultPlatform ?? platforms[0] ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [icon, setIcon] = useState(group?.icon ?? '');
  const [color, setColor] = useState(group?.color ?? DEFAULT_COLOR);
  const [tablesText, setTablesText] = useState((group?.tables ?? []).join(', '));
  const [externalGroupId, setExternalGroupId] = useState('');

  const parseTables = (s: string) => s.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);

  const saveMutation = useMutation({
    mutationFn: (): Promise<GroupRecord> => {
      if (isEdit && group) {
        const body: UpdateGroupInput = {
          name: name.trim(),
          description: description.trim(),
          icon: icon.trim() || null,
          color: color.trim() || null,
          tables: parseTables(tablesText),
        };
        return updateGroup(group.id, body);
      }
      const body: CreateGroupInput = {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim(),
        platform,
        icon: icon.trim() || undefined,
        color: color.trim() || undefined,
        tables: parseTables(tablesText),
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

  const slugValid = /^[a-z0-9-]+$/.test(slug.trim());
  const canSave =
    name.trim().length > 0 &&
    description.trim().length > 0 &&
    (isEdit || (slugValid && platform.length > 0));

  const LucideIcon = (Icons as any)[icon] || Icons.Layers;

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
            onChange={(e) => {
              const v = e.target.value;
              setName(v);
              if (!isEdit && !slugTouched) setSlug(slugify(v));
            }}
            autoFocus
          />
        </div>

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Slug</label>
          <input
            className="form-input"
            value={slug}
            placeholder="credit-card"
            disabled={isEdit}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
          />
          {isEdit && (
            <div style={{ fontSize: '11px', color: 'var(--text-light)', marginTop: '4px' }}>
              Slug can't be changed after creation.
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

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Color</label>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              type="color"
              value={color || DEFAULT_COLOR}
              onChange={(e) => setColor(e.target.value)}
              style={{ width: '42px', height: '38px', padding: 0, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'none' }}
            />
            <input className="form-input" value={color} placeholder="#FF9900" onChange={(e) => setColor(e.target.value)} style={{ flex: 1 }} />
          </div>
        </div>

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Icon (Lucide name)</label>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <div
              className="group-icon-box"
              style={{ width: '38px', height: '38px', borderRadius: '8px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <LucideIcon size={18} style={{ color: color || 'var(--primary)' }} />
            </div>
            <input className="form-input" value={icon} placeholder="CreditCard" onChange={(e) => setIcon(e.target.value)} style={{ flex: 1 }} />
          </div>
        </div>

        {!isEdit && (
          <div className="form-group" style={{ marginBottom: 0 }}>
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
          <label className="form-label">Description</label>
          <input
            className="form-input"
            value={description}
            placeholder="What data / tables this group grants access to"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="form-group" style={{ marginBottom: 0, gridColumn: '1 / -1' }}>
          <label className="form-label">Tables (comma-separated)</label>
          <input
            className="form-input"
            value={tablesText}
            placeholder="card_transactions, billing_statements"
            onChange={(e) => setTablesText(e.target.value)}
          />
        </div>
      </div>

      {!isEdit && slug.trim() && !slugValid && (
        <div style={{ fontSize: '11px', color: 'var(--status-rejected-text)', marginTop: '8px' }}>
          Slug must be lowercase alphanumeric with hyphens.
        </div>
      )}
    </Modal>
  );
};

export default GroupFormModal;
