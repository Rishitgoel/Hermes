import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { queryKeys } from '../../lib/queryKeys';
import { cleanName } from './adminUtils';
import ConfirmModal from './ConfirmModal';
import AssignAdminModal from './AssignAdminModal';
import { listGroupAdmins, removeGroupAdmin, type ManageableGroup, type GroupAdminRow } from '../../services/api/admin';

type Banner = { type: 'success' | 'error'; text: string };

interface GroupAdminsTabProps {
  group: ManageableGroup;
  onBanner: (b: Banner) => void;
}

export const GroupAdminsTab: React.FC<GroupAdminsTabProps> = ({ group, onBanner }) => {
  const queryClient = useQueryClient();
  const [showAssign, setShowAssign] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<GroupAdminRow | null>(null);

  const adminsQuery = useQuery({
    queryKey: queryKeys.adminGroupAdminsForGroup(group.id),
    queryFn: () => listGroupAdmins({ groupId: group.id }),
  });

  // Prefix-invalidate so the platform-wide group-admins list and this group's list
  // both refresh, plus the groups list (its adminCount changes).
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'group-admins'] });
    queryClient.invalidateQueries({ queryKey: queryKeys.adminGroups(group.platform) });
  };

  const removeMutation = useMutation({
    mutationFn: (id: string) => removeGroupAdmin(id),
    onSuccess: () => {
      onBanner({ type: 'success', text: "Admin role removed — they're now a regular member (group access kept)." });
      setConfirmRemove(null);
      refresh();
    },
    onError: (e: any) => onBanner({ type: 'error', text: e.message || 'Failed to remove group admin.' }),
  });

  const admins = adminsQuery.data ?? [];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div className="admin-section-label">Group Admins</div>
        <button type="button" className="btn btn-outline" style={{ padding: '5px 12px', fontSize: '12px' }} onClick={() => setShowAssign(true)}>
          <Icons.UserPlus size={14} /> Add admin
        </button>
      </div>

      <p style={{ fontSize: '12px', color: 'var(--text-light)', marginBottom: '10px', lineHeight: 1.4 }}>
        Group admins can review and approve access requests for this group. They are not auto-enrolled — admin rights don't grant data access.
      </p>

      {adminsQuery.isLoading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading admins…</div>
      ) : admins.length === 0 ? (
        <div style={{ color: 'var(--text-light)', fontSize: '13px' }}>No group admins yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {admins.map((a) => (
            <div key={a.id} className="admin-row">
              <Icons.UserCheck size={16} style={{ color: 'var(--primary)' }} />
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 600, fontSize: '13.5px' }}>{cleanName(a.userName)}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: '12px', marginLeft: '8px' }}>{a.userEmail}</span>
              </div>
              <button
                type="button"
                className="btn btn-outline btn-danger-outline"
                style={{ padding: '3px 9px', fontSize: '11.5px' }}
                onClick={() => setConfirmRemove(a)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {showAssign && (
        <AssignAdminModal
          target={{ kind: 'group', groupId: group.id, groupName: group.name }}
          onClose={() => setShowAssign(false)}
          onAssigned={(msg) => {
            onBanner({ type: 'success', text: msg });
            refresh();
            setShowAssign(false);
          }}
          onError={(msg) => onBanner({ type: 'error', text: msg })}
        />
      )}

      <ConfirmModal
        isOpen={!!confirmRemove}
        title="Remove group admin"
        danger
        confirmLabel="Remove"
        loading={removeMutation.isPending}
        message={
          confirmRemove
            ? `Remove ${cleanName(confirmRemove.userName)} as an admin of ${group.name}? Their group membership (if any) is kept.`
            : ''
        }
        onConfirm={() => confirmRemove && removeMutation.mutate(confirmRemove.id)}
        onClose={() => setConfirmRemove(null)}
      />
    </div>
  );
};

export default GroupAdminsTab;
