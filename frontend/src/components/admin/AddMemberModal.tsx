import React, { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { queryKeys } from '../../lib/queryKeys';
import { cleanName } from './adminUtils';
import {
  searchUsers,
  addGroupMember,
  listGroupLevels,
  type AdminUser,
  type ManageableGroup,
  type AccessDurationValue,
} from '../../services/api/admin';

/** Small debounce so the user-search query doesn't fire on every keystroke. */
function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

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
 * as AssignAdminModal, plus a level picker (required when the group has active
 * levels) and a duration picker.
 */
export const AddMemberModal: React.FC<AddMemberModalProps> = ({ group, existingMemberIds, onClose, onAdded, onError }) => {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [levelId, setLevelId] = useState('');
  const [duration, setDuration] = useState<AccessDurationValue>('PERMANENT');
  const debouncedSearch = useDebounced(search, 300);

  const usersQuery = useQuery({
    queryKey: queryKeys.adminUsers(debouncedSearch),
    queryFn: () => searchUsers(debouncedSearch),
  });

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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">Add member to {group.name}</div>
          <button type="button" className="modal-close-btn" onClick={onClose}>
            <Icons.X size={20} />
          </button>
        </div>

        <div className="modal-body">
          <div style={{ position: 'relative', marginBottom: '14px' }}>
            <Icons.Search size={16} style={{ position: 'absolute', top: '13px', left: '14px', color: 'var(--text-light)' }} />
            <input
              type="text"
              className="form-input"
              placeholder="Search users by name or email…"
              style={{ paddingLeft: '40px' }}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSelected(null);
              }}
              autoFocus
            />
          </div>

          <div style={{ maxHeight: '220px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
            {usersQuery.isLoading ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '8px' }}>Searching…</div>
            ) : usersQuery.isError ? (
              <div style={{ color: 'var(--status-rejected-text)', fontSize: '13px', padding: '8px' }}>
                {(usersQuery.error as any)?.message || 'Failed to search users.'}
              </div>
            ) : (usersQuery.data ?? []).length === 0 ? (
              <div style={{ color: 'var(--text-light)', fontSize: '13px', padding: '8px' }}>
                {debouncedSearch
                  ? 'No matching users. They must sign in to Hermes once before they can be added.'
                  : 'No users yet. Users appear here once they have signed in to Hermes.'}
              </div>
            ) : (
              (usersQuery.data ?? []).map((u) => {
                const isMember = existingMemberIds.has(u.userId);
                const isSel = selected?.userId === u.userId;
                return (
                  <button
                    key={u.userId}
                    type="button"
                    disabled={isMember}
                    onClick={() => setSelected(u)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '10px 12px',
                      border: `1px solid ${isSel ? 'var(--primary)' : 'var(--border)'}`,
                      background: isSel ? 'var(--primary-light)' : 'white',
                      borderRadius: 'var(--radius-md)',
                      cursor: isMember ? 'not-allowed' : 'pointer',
                      opacity: isMember ? 0.55 : 1,
                      textAlign: 'left',
                    }}
                  >
                    <Icons.UserCircle size={20} style={{ color: isSel ? 'var(--primary)' : 'var(--text-light)' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: '13px' }}>{cleanName(u.userName)}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{u.userEmail}</div>
                    </div>
                    {isMember ? (
                      <span style={{ fontSize: '11px', color: 'var(--text-light)', fontWeight: 600 }}>Already a member</span>
                    ) : (
                      isSel && <Icons.Check size={16} style={{ color: 'var(--primary)' }} />
                    )}
                  </button>
                );
              })
            )}
          </div>

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

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Access Duration</label>
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

        <div className="modal-footer">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={addMutation.isPending}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={() => addMutation.mutate()}>
            {addMutation.isPending ? 'Adding…' : 'Add member'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AddMemberModal;
