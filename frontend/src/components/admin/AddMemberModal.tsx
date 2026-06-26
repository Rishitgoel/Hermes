import React, { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { queryKeys } from '../../lib/queryKeys';
import { cleanName } from './adminUtils';
import UserPicker from './UserPicker';
import {
  addGroupMember,
  listGroupLevels,
  type AdminUser,
  type ManageableGroup,
  type AccessDurationValue,
} from '../../services/api/admin';

interface AddMemberModalProps {
  group: ManageableGroup;
  /** userIds already holding an active grant — shown as un-selectable. */
  existingMemberIds: Set<string>;
  onClose: () => void;
  onAdded: (message: string) => void;
  onError: (message: string) => void;
}

/**
 * Add a user to a group directly from Admin Management (Members tab) — the
 * admin-side equivalent of an already-approved access request. Same user search
 * as AssignAdminModal (shared UserPicker), plus a level picker (required when the
 * group has active levels) and a duration picker.
 */
export const AddMemberModal: React.FC<AddMemberModalProps> = ({ group, existingMemberIds, onClose, onAdded, onError }) => {
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [levelId, setLevelId] = useState('');
  const [duration, setDuration] = useState<AccessDurationValue>('PERMANENT');

  // Shares the query key with the Levels/Members tabs so the data is fetched once.
  const levelsQuery = useQuery({
    queryKey: queryKeys.adminGroupLevels(group.id),
    queryFn: () => listGroupLevels(group.id),
  });
  const activeLevels = (levelsQuery.data ?? []).filter((l) => l.isActive);
  const needsLevel = activeLevels.length > 0;

  const addMutation = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('Select a user first');
      return addGroupMember(group.id, {
        userId: selected.userId,
        ...(needsLevel ? { levelId } : {}),
        duration,
      });
    },
    onSuccess: (result) => {
      onAdded(
        result.kind === 'provisioned'
          ? `${cleanName(selected!.userName)} was added to ${group.name}.`
          : `${cleanName(selected!.userName)} will be added to ${group.name} automatically once their platform account setup completes.`,
      );
    },
    onError: (e: any) => onError(e.message || 'Failed to add member.'),
  });

  const canSubmit = !!selected && (!needsLevel || !!levelId) && !addMutation.isPending;

  const submit = () => {
    if (canSubmit) addMutation.mutate();
  };

  const helper = !selected ? 'Select a user to add.' : needsLevel && !levelId ? 'Pick a level below.' : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="modal-title">Add member to {group.name}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px', lineHeight: 1.4 }}>
              Grants access directly — no request to review.
            </div>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose}>
            <Icons.X size={20} />
          </button>
        </div>

        <div className="modal-body">
          <UserPicker
            selected={selected}
            onSelect={setSelected}
            disabledIds={existingMemberIds}
            disabledLabel="Already a member"
            emptyVerb="added"
            onSubmit={submit}
            onCancel={onClose}
            listMaxHeight={220}
          />

          <div style={{ marginTop: '14px' }}>
            {needsLevel && (
              <div className="form-group" style={{ marginBottom: '14px' }}>
                <label className="form-label">Level</label>
                <select className="form-select" value={levelId} onChange={(e) => setLevelId(e.target.value)} disabled={addMutation.isPending}>
                  <option value="" disabled>
                    Select a level…
                  </option>
                  {activeLevels.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                      {l.permission ? ` · ${l.permission}` : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="form-group form-row" style={{ marginBottom: 0 }}>
              <label className="form-label">Duration</label>
              <select
                className="form-select"
                value={duration}
                onChange={(e) => setDuration(e.target.value as AccessDurationValue)}
                disabled={addMutation.isPending}
              >
                <option value="PERMANENT">Permanent Access</option>
                <option value="ONE_DAY">1 Day (Temp Access)</option>
                <option value="ONE_WEEK">1 Week</option>
                <option value="ONE_MONTH">1 Month</option>
                <option value="THREE_MONTHS">3 Months</option>
              </select>
            </div>
          </div>
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <div style={{ fontSize: '12px', color: selected ? 'var(--text-muted)' : 'var(--text-light)', display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
            {helper ? (
              helper
            ) : (
              <>
                <Icons.UserCheck size={14} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <strong style={{ fontWeight: 600 }}>{cleanName(selected!.userName)}</strong> selected
                </span>
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={addMutation.isPending}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canSubmit}
              style={!canSubmit ? { background: 'var(--bg-inset)', color: 'var(--text-light)', boxShadow: 'none' } : undefined}
              onClick={submit}
            >
              {addMutation.isPending ? 'Adding…' : 'Add member'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AddMemberModal;
