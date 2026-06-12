import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { queryKeys } from '../../lib/queryKeys';
import { cleanName } from './adminUtils';
import { SkeletonRows } from '../common/Skeleton';
import ConfirmModal from './ConfirmModal';
import AddMemberModal from './AddMemberModal';
import {
  listGroupMembers,
  removeGroupMember,
  setGroupMemberLevel,
  listGroupLevels,
  type ManageableGroup,
  type GroupMember,
} from '../../services/api/admin';

type Banner = { type: 'success' | 'error'; text: string };

interface GroupMembersTabProps {
  group: ManageableGroup;
  onBanner: (b: Banner) => void;
}

export const GroupMembersTab: React.FC<GroupMembersTabProps> = ({ group, onBanner }) => {
  const queryClient = useQueryClient();
  const [confirmRemove, setConfirmRemove] = useState<GroupMember | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const membersQuery = useQuery({
    queryKey: queryKeys.adminGroupMembers(group.id),
    queryFn: () => listGroupMembers(group.id),
  });

  // Active levels drive the per-member level selector. Shares the query key with the
  // Levels tab so the data is fetched once.
  const levelsQuery = useQuery({
    queryKey: queryKeys.adminGroupLevels(group.id),
    queryFn: () => listGroupLevels(group.id),
  });
  const activeLevels = (levelsQuery.data ?? []).filter((l) => l.isActive);

  const refreshMembers = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.adminGroupMembers(group.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.adminGroups(group.platform) });
  };

  const removeMutation = useMutation({
    mutationFn: (userAccessId: string) => removeGroupMember(group.id, userAccessId),
    onSuccess: () => {
      onBanner({ type: 'success', text: 'Member removed from group.' });
      setConfirmRemove(null);
      refreshMembers();
    },
    onError: (e: any) => onBanner({ type: 'error', text: e.message || 'Failed to remove member.' }),
  });

  const setLevelMutation = useMutation({
    mutationFn: ({ userAccessId, levelId }: { userAccessId: string; levelId: string }) =>
      setGroupMemberLevel(group.id, userAccessId, levelId),
    onSuccess: () => {
      onBanner({ type: 'success', text: 'Member level updated.' });
      refreshMembers();
      queryClient.invalidateQueries({ queryKey: queryKeys.adminGroupLevels(group.id) });
    },
    onError: (e: any) => onBanner({ type: 'error', text: e.message || 'Failed to update member level.' }),
  });

  const members = useMemo(() => membersQuery.data ?? [], [membersQuery.data]);
  const memberUserIds = useMemo(() => new Set(members.map((m) => m.userId)), [members]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div className="admin-section-label">Members</div>
        <button type="button" className="btn btn-outline" style={{ padding: '5px 12px', fontSize: '12px' }} onClick={() => setShowAdd(true)}>
          <Icons.UserPlus size={14} /> Add member
        </button>
      </div>

      {membersQuery.isLoading ? (
        <SkeletonRows count={3} />
      ) : members.length === 0 ? (
        <div style={{ color: 'var(--text-light)', fontSize: '13px' }}>No active members.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {members.map((m) => {
            const currentIsActive = activeLevels.some((l) => l.id === m.levelId);
            return (
              <div key={m.id} className="admin-row">
                <Icons.User size={16} style={{ color: 'var(--text-light)' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, fontSize: '13px' }}>{cleanName(m.userName)}</span>
                  {m.isAdmin && (
                    <span
                      title="Also a group admin — removing their membership keeps their approval rights"
                      style={{
                        marginLeft: '8px',
                        fontSize: '10px',
                        fontWeight: 800,
                        letterSpacing: '0.04em',
                        padding: '1px 7px',
                        borderRadius: 999,
                        background: 'var(--primary-light)',
                        color: 'var(--primary)',
                        border: '1px solid var(--primary)',
                      }}
                    >
                      ADMIN
                    </span>
                  )}
                  <span style={{ color: 'var(--text-muted)', fontSize: '12px', marginLeft: '8px' }}>{m.userEmail}</span>
                </div>

                {activeLevels.length > 0 && (
                  <select
                    className="form-select"
                    title="Member level"
                    style={{ height: '30px', fontSize: '12px', padding: '2px 8px', width: 'auto', maxWidth: '180px' }}
                    value={currentIsActive ? (m.levelId ?? '') : ''}
                    disabled={setLevelMutation.isPending}
                    onChange={(e) => {
                      const newLevelId = e.target.value;
                      if (!newLevelId || newLevelId === m.levelId) return;
                      setLevelMutation.mutate({ userAccessId: m.id, levelId: newLevelId });
                    }}
                  >
                    {!currentIsActive && (
                      <option value="" disabled>
                        {m.levelName ? `${m.levelName} (inactive)` : '— no level —'}
                      </option>
                    )}
                    {activeLevels.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                        {l.permission ? ` · ${l.permission}` : ''}
                      </option>
                    ))}
                  </select>
                )}

                {m.expiresAt && (
                  <span className="badge badge-pending" style={{ fontSize: '10px' }}>
                    expires {new Date(m.expiresAt).toLocaleDateString()}
                  </span>
                )}

                <button
                  type="button"
                  className="btn btn-outline btn-danger-outline"
                  style={{ padding: '3px 9px', fontSize: '12px' }}
                  onClick={() => setConfirmRemove(m)}
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <AddMemberModal
          group={group}
          existingMemberIds={memberUserIds}
          onClose={() => setShowAdd(false)}
          onAdded={(msg) => {
            onBanner({ type: 'success', text: msg });
            setShowAdd(false);
            refreshMembers();
            queryClient.invalidateQueries({ queryKey: queryKeys.adminGroupLevels(group.id) });
          }}
          onError={(msg) => onBanner({ type: 'error', text: msg })}
        />
      )}

      <ConfirmModal
        isOpen={!!confirmRemove}
        title="Remove member"
        danger
        confirmLabel="Remove"
        loading={removeMutation.isPending}
        message={
          confirmRemove
            ? `Remove ${cleanName(confirmRemove.userName)} from ${group.name}? This revokes their access on the platform.${
                confirmRemove.isAdmin ? ' They keep their group-admin (approval) rights.' : ''
              }`
            : ''
        }
        onConfirm={() => confirmRemove && removeMutation.mutate(confirmRemove.id)}
        onClose={() => setConfirmRemove(null)}
      />
    </div>
  );
};

export default GroupMembersTab;
