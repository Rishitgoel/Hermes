import React, { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { queryKeys } from '../../lib/queryKeys';
import { prettyPlatform, cleanName } from './adminUtils';
import { searchUsers, assignPlatformAdmin, assignGroupAdmin, type AdminUser } from '../../services/api/admin';

/** What an assignment targets: a whole platform, or a single group. */
export type AssignTarget =
  | { kind: 'platform'; platform: string }
  | { kind: 'group'; groupId: string; groupName: string };

/** Small debounce so the user-search query doesn't fire on every keystroke. */
function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

interface AssignAdminModalProps {
  target: AssignTarget;
  onClose: () => void;
  onAssigned: (message: string) => void;
  onError: (message: string) => void;
}

export const AssignAdminModal: React.FC<AssignAdminModalProps> = ({ target, onClose, onAssigned, onError }) => {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const debouncedSearch = useDebounced(search, 300);

  const usersQuery = useQuery({
    queryKey: queryKeys.adminUsers(debouncedSearch),
    queryFn: () => searchUsers(debouncedSearch),
  });

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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
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

          <div style={{ maxHeight: '280px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {usersQuery.isLoading ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '8px' }}>Searching…</div>
            ) : usersQuery.isError ? (
              <div style={{ color: 'var(--status-rejected-text)', fontSize: '13px', padding: '8px' }}>
                {(usersQuery.error as any)?.message || 'Failed to search users.'}
              </div>
            ) : (usersQuery.data ?? []).length === 0 ? (
              <div style={{ color: 'var(--text-light)', fontSize: '13px', padding: '8px' }}>
                {debouncedSearch
                  ? 'No matching users. They must sign in to Hermes once before they can be promoted.'
                  : 'No users yet. Users appear here once they have signed in to Hermes.'}
              </div>
            ) : (
              (usersQuery.data ?? []).map((u) => {
                const isSel = selected?.userId === u.userId;
                return (
                  <button
                    key={u.userId}
                    type="button"
                    onClick={() => setSelected(u)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '10px 12px',
                      border: `1px solid ${isSel ? 'var(--primary)' : 'var(--border)'}`,
                      background: isSel ? 'var(--primary-light)' : 'white',
                      borderRadius: 'var(--radius-md)',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <Icons.UserCircle size={20} style={{ color: isSel ? 'var(--primary)' : 'var(--text-light)' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: '13.5px' }}>{cleanName(u.userName)}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{u.userEmail}</div>
                    </div>
                    {isSel && <Icons.Check size={16} style={{ color: 'var(--primary)' }} />}
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={assignMutation.isPending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!selected || assignMutation.isPending}
            onClick={() => assignMutation.mutate()}
          >
            {assignMutation.isPending ? 'Assigning…' : 'Assign'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AssignAdminModal;
