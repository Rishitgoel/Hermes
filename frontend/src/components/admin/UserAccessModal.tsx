import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { queryKeys } from '../../lib/queryKeys';
import { useToast } from '../../contexts/ToastContext';
import LoadingSpinner from '../common/LoadingSpinner';
import { prettyPlatform, cleanName, groupIconName } from './adminUtils';
import UserPicker from './UserPicker';
import ConfirmModal from './ConfirmModal';
import {
  listUserAccess,
  revokeUserAccess,
  listUserPlatformAccounts,
  disableUserAccounts,
  type AdminUser,
  type UserAccessRow,
  type UserPlatformAccountRow,
} from '../../services/api/admin';

interface UserAccessModalProps {
  onClose: () => void;
}

function formatDate(d: string | null): string {
  return d ? new Date(d).toLocaleDateString() : 'never';
}

const ACCOUNT_STATUS_LABEL: Record<UserPlatformAccountRow['status'], string> = {
  COMPLETED: 'Active account',
  AWAITING_SETUP: 'Awaiting setup',
  APPROVED: 'Invite in flight',
};

/**
 * "Check what a user has access to, revoke it, and offboard their platform
 * accounts" — the cross-platform complement to a single group's Members tab.
 * Two independent tools live here side by side because they act on different
 * things and don't imply each other:
 *  - Access grants: group membership / data access (UserAccess rows).
 *  - Platform accounts: the account itself (can they still sign in at all?).
 *    Disabling it does NOT revoke grants for a reversible platform (Redash —
 *    group membership survives a re-enable); it DOES for an irreversible one
 *    (AWS — the backend auto-revokes, since a deleted account can never again
 *    validly back an active grant). See CLAUDE.md's Offboarding section.
 */
export const UserAccessModal: React.FC<UserAccessModalProps> = ({ onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [reason, setReason] = useState('');

  // ── Access grants (revoke) ────────────────────────────────────────────────
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  const accessQuery = useQuery({
    queryKey: queryKeys.adminUserAccess(selectedUser?.userId ?? ''),
    queryFn: () => listUserAccess(selectedUser!.userId),
    enabled: !!selectedUser,
  });

  const rows = useMemo(() => accessQuery.data ?? [], [accessQuery.data]);
  const checkedRows = useMemo(() => rows.filter((r) => checked.has(r.id)), [rows, checked]);
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.id));

  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(rows.map((r) => r.id)));
  const toggleOne = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const revokeMutation = useMutation({
    mutationFn: () =>
      revokeUserAccess(selectedUser!.userId, {
        userAccessIds: Array.from(checked),
        reason: reason.trim() || undefined,
      }),
    onSuccess: (result) => {
      setConfirming(false);
      const groupIds = new Set(checkedRows.map((r) => r.groupId));
      const platforms = new Set(checkedRows.map((r) => r.platform));
      groupIds.forEach((gid) => queryClient.invalidateQueries({ queryKey: queryKeys.adminGroupMembers(gid) }));
      platforms.forEach((p) => queryClient.invalidateQueries({ queryKey: queryKeys.adminGroups(p) }));
      queryClient.invalidateQueries({ queryKey: queryKeys.groups() });
      queryClient.invalidateQueries({ queryKey: queryKeys.adminUserAccess(selectedUser!.userId) });
      setChecked(new Set());
      if (result.failed.length > 0) {
        toast.error(
          `${result.revoked.length} revoked, ${result.failed.length} failed (${result.failed
            .map((f) => f.groupName)
            .join(', ')}).`,
        );
      } else {
        toast.success(`Revoked ${result.revoked.length} access grant${result.revoked.length === 1 ? '' : 's'}.`);
      }
    },
    onError: (e: any) => {
      setConfirming(false);
      toast.error(e.message || 'Failed to revoke access.');
    },
  });

  // ── Platform accounts (offboarding: disable/delete the account itself) ────
  const [checkedAccounts, setCheckedAccounts] = useState<Set<string>>(new Set()); // keyed by platform
  const [confirmingAccounts, setConfirmingAccounts] = useState(false);

  const accountsQuery = useQuery({
    queryKey: queryKeys.adminUserPlatformAccounts(selectedUser?.userId ?? ''),
    queryFn: () => listUserPlatformAccounts(selectedUser!.userId),
    enabled: !!selectedUser,
  });

  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const disableableAccounts = useMemo(() => accounts.filter((a) => a.supportsDisable), [accounts]);
  const unsupportedAccounts = useMemo(() => accounts.filter((a) => !a.supportsDisable), [accounts]);
  const checkedAccountRows = useMemo(
    () => disableableAccounts.filter((a) => checkedAccounts.has(a.platform)),
    [disableableAccounts, checkedAccounts],
  );
  const allAccountsChecked = disableableAccounts.length > 0 && disableableAccounts.every((a) => checkedAccounts.has(a.platform));
  const hasIrreversibleSelected = checkedAccountRows.some((a) => !a.disableIsReversible);

  const toggleAllAccounts = () =>
    setCheckedAccounts(allAccountsChecked ? new Set() : new Set(disableableAccounts.map((a) => a.platform)));
  const toggleAccount = (platform: string) =>
    setCheckedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(platform)) next.delete(platform);
      else next.add(platform);
      return next;
    });

  const disableMutation = useMutation({
    mutationFn: () =>
      disableUserAccounts(selectedUser!.userId, {
        platforms: Array.from(checkedAccounts),
        reason: reason.trim() || undefined,
      }),
    onSuccess: (result) => {
      setConfirmingAccounts(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.adminUserPlatformAccounts(selectedUser!.userId) });
      const totalGrantsRevoked = result.disabled.reduce((n, d) => n + d.grantsRevoked.length, 0);
      if (totalGrantsRevoked > 0) {
        // A permanent delete auto-revoked grants on that platform — refresh the
        // same caches the grants-revoke path does.
        queryClient.invalidateQueries({ queryKey: queryKeys.groups() });
        result.disabled.forEach((d) => queryClient.invalidateQueries({ queryKey: queryKeys.adminGroups(d.platform) }));
        queryClient.invalidateQueries({ queryKey: queryKeys.adminUserAccess(selectedUser!.userId) });
        queryClient.invalidateQueries({ queryKey: ['admin', 'group-members'] });
      }
      setCheckedAccounts(new Set());
      if (result.failed.length > 0) {
        toast.error(
          `${result.disabled.length} disabled, ${result.failed.length} failed (${result.failed
            .map((f) => prettyPlatform(f.platform))
            .join(', ')}).`,
        );
      } else {
        toast.success(
          `${result.disabled.length} account${result.disabled.length === 1 ? '' : 's'} disabled` +
            (totalGrantsRevoked > 0 ? ` — also revoked ${totalGrantsRevoked} grant(s) on permanently-deleted account(s).` : '.'),
        );
      }
    },
    onError: (e: any) => {
      setConfirmingAccounts(false);
      toast.error(e.message || 'Failed to disable accounts.');
    },
  });

  const switchUser = () => {
    setSelectedUser(null);
    setChecked(new Set());
    setCheckedAccounts(new Set());
    setReason('');
  };

  const hasAnyData = rows.length > 0 || accounts.length > 0;

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content" style={{ maxWidth: '760px' }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <div>
              <div className="modal-title">User access</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                Audit, revoke, and offboard a user across every platform you administer.
              </div>
            </div>
            <button type="button" className="modal-close-btn" onClick={onClose}>
              <Icons.X size={20} />
            </button>
          </div>

          <div className="modal-body">
            {!selectedUser ? (
              <UserPicker selected={selectedUser} onSelect={setSelectedUser} emptyVerb="looked up" listMaxHeight={320} />
            ) : (
              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    paddingBottom: '12px',
                    marginBottom: '14px',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontWeight: 700, fontSize: '14px', whiteSpace: 'nowrap' }}>{cleanName(selectedUser.userName)}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedUser.userEmail}</span>
                  </div>
                  <button type="button" className="btn btn-outline btn-sm" style={{ flexShrink: 0 }} onClick={switchUser}>
                    Change user
                  </button>
                </div>

                {accessQuery.isLoading || accountsQuery.isLoading ? (
                  <LoadingSpinner />
                ) : accessQuery.isError || accountsQuery.isError ? (
                  <div className="empty-state" style={{ padding: '20px' }}>
                    <p className="empty-state-desc" style={{ fontSize: '13px', color: 'var(--status-rejected-text)' }}>
                      {(accessQuery.error as any)?.message || (accountsQuery.error as any)?.message || 'Failed to load access.'}
                    </p>
                  </div>
                ) : !hasAnyData ? (
                  <div className="empty-state" style={{ padding: '24px' }}>
                    <Icons.ShieldCheck size={30} className="empty-state-icon" />
                    <p className="empty-state-desc" style={{ fontSize: '13px' }}>
                      No active access or accounts on any platform you administer.
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Access grants + Platform accounts, side by side */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch' }}>
                      {/* Access grants */}
                      <div style={{ flex: '1 1 300px', minWidth: '280px', paddingRight: '24px' }}>
                        <div
                          style={{
                            fontSize: '12px',
                            fontWeight: 700,
                            color: 'var(--text-light)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.03em',
                            margin: '0 2px 8px',
                          }}
                        >
                          Access grants
                        </div>
                        {rows.length === 0 ? (
                          <div style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '8px 2px' }}>No active grants.</div>
                        ) : (
                          <>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 2px 8px', fontSize: '12px', color: 'var(--text-muted)', cursor: 'pointer' }}>
                              <input type="checkbox" checked={allChecked} onChange={toggleAll} />
                              Select all ({rows.length})
                            </label>
                            <div style={{ maxHeight: '260px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                              {rows.map((r) => (
                                <UserAccessRowItem key={r.id} row={r} checked={checked.has(r.id)} onToggle={() => toggleOne(r.id)} />
                              ))}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '10px 0 0' }}>
                              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                                {checked.size === 0 ? 'Select to revoke.' : `${checked.size} of ${rows.length}`}
                              </div>
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                style={
                                  checked.size > 0
                                    ? { background: 'var(--status-rejected-text)', borderColor: 'var(--status-rejected-text)' }
                                    : { background: 'var(--bg-inset)', color: 'var(--text-light)', boxShadow: 'none' }
                                }
                                disabled={checked.size === 0 || revokeMutation.isPending}
                                onClick={() => setConfirming(true)}
                              >
                                <Icons.ShieldOff size={14} /> Revoke{checked.size > 0 ? ` (${checked.size})` : ''}
                              </button>
                            </div>
                          </>
                        )}
                      </div>

                      {/* Vertical divider — only meaningful once the columns sit side by side;
                          flexWrap makes it disappear (0 width) when they stack on a narrow modal. */}
                      <div style={{ width: '1px', background: 'var(--border)', alignSelf: 'stretch', flexShrink: 0 }} />

                      {/* Platform accounts (offboarding) */}
                      <div style={{ flex: '1 1 300px', minWidth: '280px', paddingLeft: '24px' }}>
                        <div
                          style={{
                            fontSize: '12px',
                            fontWeight: 700,
                            color: 'var(--text-light)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.03em',
                            margin: '0 2px 8px',
                          }}
                        >
                          Platform accounts
                        </div>
                        {accounts.length === 0 ? (
                          <div style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '8px 2px' }}>No platform accounts found.</div>
                        ) : (
                          <>
                            {disableableAccounts.length > 0 ? (
                              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 2px 8px', fontSize: '12px', color: 'var(--text-muted)', cursor: 'pointer' }}>
                                <input type="checkbox" checked={allAccountsChecked} onChange={toggleAllAccounts} />
                                Select all ({disableableAccounts.length})
                              </label>
                            ) : (
                              // Keep the two columns' list content vertically aligned even
                              // when this column has no "select all" row to show.
                              <div style={{ height: '25px' }} />
                            )}
                            <div style={{ maxHeight: '260px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                              {disableableAccounts.map((a) => (
                                <UserPlatformAccountRowItem
                                  key={a.platform}
                                  account={a}
                                  checked={checkedAccounts.has(a.platform)}
                                  onToggle={() => toggleAccount(a.platform)}
                                />
                              ))}
                              {unsupportedAccounts.map((a) => (
                                <div
                                  key={a.platform}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '10px',
                                    padding: '9px 11px',
                                    border: '1px solid var(--border)',
                                    borderRadius: 'var(--radius-md)',
                                    opacity: 0.7,
                                  }}
                                >
                                  <Icons.Ban size={14} style={{ color: 'var(--text-light)', flexShrink: 0 }} />
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, fontSize: '13px' }}>{prettyPlatform(a.platform)}</div>
                                    <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                                      No account-level action here — its access grants above are sufficient.
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                            {disableableAccounts.length > 0 && (
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '10px 0 0' }}>
                                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                                  {checkedAccounts.size === 0
                                    ? 'Select to disable.'
                                    : `${checkedAccounts.size} of ${disableableAccounts.length}`}
                                </div>
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  style={
                                    checkedAccounts.size > 0
                                      ? { background: 'var(--status-rejected-text)', borderColor: 'var(--status-rejected-text)' }
                                      : { background: 'var(--bg-inset)', color: 'var(--text-light)', boxShadow: 'none' }
                                  }
                                  disabled={checkedAccounts.size === 0 || disableMutation.isPending}
                                  onClick={() => setConfirmingAccounts(true)}
                                >
                                  <Icons.UserX size={14} />
                                  {hasIrreversibleSelected ? 'Delete/disable' : 'Disable'}
                                  {checkedAccounts.size > 0 ? ` (${checkedAccounts.size})` : ''}
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    <input
                      type="text"
                      className="form-input"
                      placeholder="Reason (optional, shown in the audit log)"
                      style={{ marginTop: '18px' }}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      maxLength={500}
                    />
                  </>
                )}
              </div>
            )}
          </div>

          {selectedUser && (
            <div className="modal-footer" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-outline" onClick={onClose}>
                Close
              </button>
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={confirming}
        title="Revoke access"
        danger
        confirmLabel={revokeMutation.isPending ? 'Revoking…' : 'Revoke'}
        loading={revokeMutation.isPending}
        message={
          <>
            Revoke {checkedRows.length} access grant{checkedRows.length === 1 ? '' : 's'} for{' '}
            <strong>{selectedUser ? cleanName(selectedUser.userName) : ''}</strong>? This deprovisions them from each platform
            immediately.
            <ul style={{ margin: '10px 0 0', paddingLeft: '18px' }}>
              {checkedRows.map((r) => (
                <li key={r.id}>
                  {r.groupName} ({prettyPlatform(r.platform)}
                  {r.levelName ? ` · ${r.levelName}` : ''})
                </li>
              ))}
            </ul>
          </>
        }
        onConfirm={() => revokeMutation.mutate()}
        onClose={() => setConfirming(false)}
      />

      <ConfirmModal
        isOpen={confirmingAccounts}
        title={hasIrreversibleSelected ? 'Permanently delete account(s)' : 'Disable account(s)'}
        danger
        requireTypedConfirmation={hasIrreversibleSelected ? 'DELETE' : undefined}
        confirmLabel={disableMutation.isPending ? 'Working…' : hasIrreversibleSelected ? 'Delete / disable' : 'Disable'}
        loading={disableMutation.isPending}
        message={
          <>
            This shuts off <strong>{selectedUser ? cleanName(selectedUser.userName) : ''}</strong>'s ability to sign in on the
            selected platform(s):
            <ul style={{ margin: '10px 0 0', paddingLeft: '18px' }}>
              {checkedAccountRows.map((a) => (
                <li key={a.platform} style={a.disableIsReversible ? undefined : { color: 'var(--status-rejected-text)', fontWeight: 600 }}>
                  {prettyPlatform(a.platform)} —{' '}
                  {a.disableIsReversible ? 'disable (reversible)' : 'permanently delete (cannot be undone)'}
                  {a.activeGrantCount > 0 && (
                    <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>
                      {' '}
                      · {a.activeGrantCount} active grant{a.activeGrantCount === 1 ? '' : 's'}{' '}
                      {a.disableIsReversible ? 'will remain untouched' : 'will also be auto-revoked'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        }
        onConfirm={() => disableMutation.mutate()}
        onClose={() => setConfirmingAccounts(false)}
      />
    </>
  );
};

const UserAccessRowItem: React.FC<{ row: UserAccessRow; checked: boolean; onToggle: () => void }> = ({
  row,
  checked,
  onToggle,
}) => {
  const LucideIcon =
    (Icons as any)[groupIconName({ slug: row.groupSlug, id: row.groupId, name: row.groupName, icon: row.groupIcon })] ||
    Icons.Layers;
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '9px 11px',
        border: `1px solid ${checked ? 'var(--primary)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        background: checked ? 'var(--primary-light)' : 'var(--bg-card)',
      }}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <div
        style={{
          width: '28px',
          height: '28px',
          borderRadius: '7px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg-inset)',
        }}
      >
        <LucideIcon size={14} style={{ color: row.groupColor || 'var(--primary)' }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          {row.groupName}
          <span
            style={{
              fontSize: '10px',
              fontWeight: 700,
              color: 'var(--text-light)',
              textTransform: 'uppercase',
              letterSpacing: '0.03em',
            }}
          >
            {prettyPlatform(row.platform)}
          </span>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
          {row.levelName ? `${row.levelName} · ` : ''}
          granted {formatDate(row.grantedAt)} · expires {formatDate(row.expiresAt)}
        </div>
      </div>
    </label>
  );
};

const UserPlatformAccountRowItem: React.FC<{
  account: UserPlatformAccountRow;
  checked: boolean;
  onToggle: () => void;
}> = ({ account, checked, onToggle }) => {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '9px 11px',
        border: `1px solid ${checked ? 'var(--primary)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        background: checked ? 'var(--primary-light)' : 'var(--bg-card)',
      }}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          {prettyPlatform(account.platform)}
          {account.isDisabled && (
            <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-light)', textTransform: 'uppercase' }}>
              already disabled
            </span>
          )}
          {!account.disableIsReversible && (
            <span
              style={{
                fontSize: '10px',
                fontWeight: 700,
                color: 'var(--status-rejected-text)',
                textTransform: 'uppercase',
                letterSpacing: '0.02em',
              }}
            >
              permanent delete
            </span>
          )}
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
          {ACCOUNT_STATUS_LABEL[account.status]}
          {account.activeGrantCount > 0 && ` · ${account.activeGrantCount} active grant${account.activeGrantCount === 1 ? '' : 's'}`}
        </div>
      </div>
    </label>
  );
};

export default UserAccessModal;
