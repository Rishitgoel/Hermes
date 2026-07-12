import React, { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { queryKeys } from '../../lib/queryKeys';
import { cleanName, prettyPlatform } from './adminUtils';
import UserPicker from './UserPicker';
import { SkeletonText } from '../common/Skeleton';
import {
  addGroupMember,
  onboardUserToGroup,
  listGroupLevels,
  type AdminUser,
  type ManageableGroup,
  type AccessDurationValue,
} from '../../services/api/admin';

interface AddMemberModalProps {
  group: ManageableGroup;
  /** userIds already holding an active grant — shown as un-selectable. */
  existingMemberIds: Set<string>;
  /** True when the caller is a platform admin of this group's platform — only
   *  they may create a platform account for a user via the recovery UI below. */
  canCreateAccount: boolean;
  onClose: () => void;
  onAdded: (message: string) => void;
  onError: (message: string) => void;
}

/**
 * Add a user to a group directly from Admin Management (Members tab) — the
 * admin-side equivalent of an already-approved access request. Same user search
 * as AssignAdminModal (shared UserPicker), plus a level picker (required when the
 * group has active levels) and a duration picker.
 *
 * If the selected user has no account yet on this group's platform, the plain add
 * fails with USER_NOT_APPROVED. Rather than a dead-end error toast, that specific
 * failure switches the modal into a recovery state offering to create the account
 * and add the user in one step — but only for platform admins (canCreateAccount);
 * a plain group admin sees the same "ask a platform admin" guidance as before.
 * This is deliberately not a standalone/always-visible action — it only appears
 * once a plain add has actually hit the gate.
 */
export const AddMemberModal: React.FC<AddMemberModalProps> = ({ group, existingMemberIds, canCreateAccount, onClose, onAdded, onError }) => {
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [levelId, setLevelId] = useState('');
  const [duration, setDuration] = useState<AccessDurationValue>('PERMANENT');
  // Set only after a plain add-member attempt fails with USER_NOT_APPROVED — this
  // is what makes the "create account" recovery UI appear on demand instead of
  // always being visible.
  const [needsAccount, setNeedsAccount] = useState(false);

  // Shares the query key with the Levels/Members tabs so the data is fetched once.
  const levelsQuery = useQuery({
    queryKey: queryKeys.adminGroupLevels(group.id),
    queryFn: () => listGroupLevels(group.id),
  });
  const activeLevels = (levelsQuery.data ?? []).filter((l) => l.isActive);
  const needsLevel = activeLevels.length > 0;

  const resetForNewSelection = (user: AdminUser | null) => {
    setSelected(user);
    setNeedsAccount(false);
  };

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
    onError: (e: any) => {
      if (e?.errorCode === 'USER_NOT_APPROVED') {
        setNeedsAccount(true);
        return;
      }
      onError(e.message || 'Failed to add member.');
    },
  });

  const onboardMutation = useMutation({
    mutationFn: () => {
      if (!selected) throw new Error('Select a user first');
      return onboardUserToGroup(group.id, {
        userId: selected.userId,
        ...(needsLevel ? { levelId } : {}),
        duration,
      });
    },
    onSuccess: (result) => {
      onAdded(
        result.membership.kind === 'provisioned'
          ? `${cleanName(selected!.userName)}'s ${prettyPlatform(group.platform)} account was created and they were added to ${group.name}.`
          : `${cleanName(selected!.userName)}'s ${prettyPlatform(group.platform)} account was created — they'll be added to ${group.name} automatically once their setup completes.`,
      );
    },
    onError: (e: any) => onError(e.message || 'Failed to create account.'),
  });

  const isPending = addMutation.isPending || onboardMutation.isPending;
  const canSubmit = !!selected && (!needsLevel || !!levelId) && !isPending && !levelsQuery.isLoading && !needsAccount;

  const submit = () => {
    if (canSubmit) addMutation.mutate();
  };

  const helper = levelsQuery.isLoading
    ? 'Loading levels…'
    : !selected
      ? 'Select a user to add.'
      : needsAccount
        ? canCreateAccount
          ? null
          : `A platform admin must create their ${prettyPlatform(group.platform)} account first.`
        : needsLevel && !levelId
          ? 'Pick a level below.'
          : null;

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
            onSelect={resetForNewSelection}
            disabledIds={existingMemberIds}
            disabledLabel="Already a member"
            emptyVerb="added"
            onSubmit={submit}
            onCancel={onClose}
            listMaxHeight={220}
          />

          {needsAccount && (
            <div
              style={{
                marginTop: '14px',
                padding: '10px 12px',
                borderRadius: '8px',
                background: 'var(--bg-inset)',
                border: '1px solid var(--border-color)',
                fontSize: '12px',
                lineHeight: 1.5,
                display: 'flex',
                gap: '8px',
                alignItems: 'flex-start',
              }}
            >
              <Icons.AlertTriangle size={15} style={{ color: 'var(--warning, #d97706)', flexShrink: 0, marginTop: '1px' }} />
              <div>
                <strong style={{ fontWeight: 600 }}>{cleanName(selected!.userName)}</strong> has no {prettyPlatform(group.platform)} account yet.{' '}
                {canCreateAccount
                  ? 'Create one and add them to this group in one step, or cancel.'
                  : `A platform admin must create their ${prettyPlatform(group.platform)} account before they can be added.`}
              </div>
            </div>
          )}

          <div style={{ marginTop: '14px' }}>
            {levelsQuery.isLoading ? (
              <div className="form-group" style={{ marginBottom: '14px' }}>
                <label className="form-label">Level</label>
                <SkeletonText />
              </div>
            ) : needsLevel && (
              <div className="form-group" style={{ marginBottom: '14px' }}>
                <label className="form-label">Level</label>
                <select className="form-select" value={levelId} onChange={(e) => setLevelId(e.target.value)} disabled={isPending}>
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
                disabled={isPending}
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
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={isPending}>
              Cancel
            </button>
            {needsAccount ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canCreateAccount || isPending || (needsLevel && !levelId)}
                style={!canCreateAccount ? { background: 'var(--bg-inset)', color: 'var(--text-light)', boxShadow: 'none' } : undefined}
                onClick={() => onboardMutation.mutate()}
              >
                {onboardMutation.isPending ? 'Creating…' : 'Create account & add'}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canSubmit}
                style={!canSubmit ? { background: 'var(--bg-inset)', color: 'var(--text-light)', boxShadow: 'none' } : undefined}
                onClick={submit}
              >
                {addMutation.isPending ? 'Adding…' : 'Add member'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AddMemberModal;
