import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { prettyPlatform, cleanName } from './adminUtils';
import { assignPlatformAdmin, assignGroupAdmin, type AdminUser } from '../../services/api/admin';
import UserPicker from './UserPicker';

/** What an assignment targets: a whole platform, or a single group. */
export type AssignTarget =
  | { kind: 'platform'; platform: string }
  | { kind: 'group'; groupId: string; groupName: string };

interface AssignAdminModalProps {
  target: AssignTarget;
  /** userIds that are already admins of this target — shown un-selectable. */
  existingAdminIds?: Set<string>;
  onClose: () => void;
  onAssigned: (message: string) => void;
  onError: (message: string) => void;
}

export const AssignAdminModal: React.FC<AssignAdminModalProps> = ({ target, existingAdminIds, onClose, onAssigned, onError }) => {
  const [selected, setSelected] = useState<AdminUser | null>(null);

  const assignMutation = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('Select a user first');
      return target.kind === 'platform'
        ? assignPlatformAdmin(selected.userId, target.platform).then(() => undefined)
        : assignGroupAdmin(selected.userId, target.groupId).then(() => undefined);
    },
    onSuccess: () => {
      const where = target.kind === 'platform' ? `${prettyPlatform(target.platform)} platform admin` : `admin of ${target.groupName}`;
      onAssigned(
        `${cleanName(selected!.userName)} is now a ${where}. The new role takes effect on their next login / token refresh.`,
      );
    },
    onError: (e: any) => onError(e.message || 'Failed to assign admin.'),
  });

  const title = target.kind === 'platform' ? `Add ${prettyPlatform(target.platform)} platform admin` : `Add admin to ${target.groupName}`;
  const subtitle =
    target.kind === 'platform'
      ? `They'll be able to manage every group on ${prettyPlatform(target.platform)} — effective on their next login.`
      : `They'll get approval rights for ${target.groupName} — effective on their next login.`;

  const submit = () => {
    if (selected && !assignMutation.isPending) assignMutation.mutate();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="modal-title">{title}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px', lineHeight: 1.4 }}>{subtitle}</div>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose}>
            <Icons.X size={20} />
          </button>
        </div>

        <div className="modal-body">
          <UserPicker
            selected={selected}
            onSelect={setSelected}
            disabledIds={existingAdminIds}
            disabledLabel="Already admin"
            emptyVerb="promoted"
            onSubmit={submit}
            onCancel={onClose}
            listMaxHeight={280}
          />
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <div style={{ fontSize: '12px', color: selected ? 'var(--text-muted)' : 'var(--text-light)', display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
            {selected ? (
              <>
                <Icons.UserCheck size={14} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <strong style={{ fontWeight: 600 }}>{cleanName(selected.userName)}</strong> selected
                </span>
              </>
            ) : (
              'Select a user to assign.'
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={assignMutation.isPending}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!selected || assignMutation.isPending}
              style={!selected ? { background: 'var(--bg-inset)', color: 'var(--text-light)', boxShadow: 'none' } : undefined}
              onClick={submit}
            >
              {assignMutation.isPending ? 'Assigning…' : 'Assign'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AssignAdminModal;
