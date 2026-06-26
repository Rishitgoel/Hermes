import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import apiClient from '../services/apiClient';
import LoadingSpinner from '../components/common/LoadingSpinner';
import EmptyState from '../components/common/EmptyState';
import ExpiryBadge from '../components/common/ExpiryBadge';
import SectionHeader from '../components/common/SectionHeader';
import ReasonModal from '../components/common/ReasonModal';
import AccessRequestModal, { type GroupLevelOption } from '../components/access/AccessRequestModal';
import RenewAccessModal from '../components/access/RenewAccessModal';
import PlatformInviteModal from '../components/access/PlatformInviteModal';
import { getMyUserCreation } from '../services/api/userCreation';
import * as Icons from 'lucide-react';
import { queryKeys } from '../lib/queryKeys';
import { platformDisplayName, DEFAULT_PLATFORM } from '../lib/platforms';
import { useToast } from '../contexts/ToastContext';

interface GroupAdmin {
  userId: string;
  userName: string;
  userEmail: string;
  assignedAt: string;
}

interface GroupMember {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  grantedAt: string;
  expiresAt: string | null;
  grantedBy: string;
  levelId: string | null;
  levelName: string | null;
}

interface GroupDetailData {
  id: string;
  name: string;
  slug: string;
  description: string;
  icon: string | null;
  color: string | null;
  platform: string;
  externalGroupId: string | null;
  accessStatus: 'ACTIVE' | 'PENDING' | 'AWAITING_SETUP' | 'NONE';
  admins: GroupAdmin[];
  members: GroupMember[];
  tables: string[];
  levels: GroupLevelOption[];
  currentLevelId: string | null;
  currentLevelName: string | null;
}

// Friendly display names per platform id. Falls back to a capitalised id so a
// newly-added platform (e.g. "aws") still renders sensibly before it's listed.
// platformDisplayName now lives in ../lib/platforms (shared).

export const GroupDetail: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [isRequestModalOpen, setIsRequestModalOpen] = useState(false);
  const [isRenewModalOpen, setIsRenewModalOpen] = useState(false);
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{ memberAccessId: string; memberName: string } | null>(null);

  const groupQuery = useQuery<GroupDetailData>({
    queryKey: queryKeys.groupDetail(slug ?? ''),
    queryFn: () => apiClient.get(`/api/groups/${slug}`).then((r) => r.data),
    enabled: !!slug,
  });

  const group = groupQuery.data;
  const isLoading = groupQuery.isLoading;

  // Gate per-platform on THIS group's platform account (see Groups.tsx for the same
  // logic): DRAFT/REJECTED — or no account request yet for this platform — must act
  // first; everyone else can queue, auto-provisioning once their account is set up.
  const accountQuery = useQuery({
    queryKey: queryKeys.userCreation(group?.platform ?? DEFAULT_PLATFORM),
    queryFn: () => getMyUserCreation(group?.platform ?? DEFAULT_PLATFORM),
    enabled: !!group?.platform,
  });
  const account = accountQuery.data ?? null;
  const userCreationStatus = account?.status ?? null;
  const needsAccountAction =
    !!group &&
    !accountQuery.isLoading &&
    (!account || userCreationStatus === 'DRAFT' || userCreationStatus === 'REJECTED');
  const isPlatformUser = !needsAccountAction;

  // If the group fetch errors (e.g. 404), bounce back to the listing.
  React.useEffect(() => {
    if (groupQuery.isError) {
      navigate('/groups');
    }
  }, [groupQuery.isError, navigate]);

  const revokeMutation = useMutation({
    mutationFn: ({ memberAccessId, reason }: { memberAccessId: string; reason: string }) =>
      apiClient.delete(`/api/user-access/${memberAccessId}`, {
        data: { reason: reason || 'Revoked manually by administrator' },
      }),
    onSuccess: () => {
      setRevokeTarget(null);
      toast.success('Access revoked.');
      queryClient.invalidateQueries({ queryKey: queryKeys.groupDetail(slug ?? '') });
      queryClient.invalidateQueries({ queryKey: queryKeys.groups() });
      queryClient.invalidateQueries({ queryKey: queryKeys.myAccess() });
    },
    onError: (err: any) => {
      toast.error(`Failed to revoke access: ${err.message}`);
    },
  });
  const revokingId = revokeMutation.isPending ? revokeMutation.variables?.memberAccessId : null;

  if (isLoading || !group) {
    return <LoadingSpinner />;
  }

  const isSuperAdmin = user?.roles.includes('hermes_super_admin') || false;
  const isGroupAdminOfThisGroup = group.admins.some((adm) => adm.userId === user?.id);
  const canManage = isSuperAdmin || isGroupAdminOfThisGroup;
  // Members who are also group admins get an ADMIN badge. Their grant is a real,
  // revocable membership — revoking it leaves their approval rights intact.
  const adminUserIds = new Set(group.admins.map((a) => a.userId));

  const renderIcon = (iconName: string | null, color: string | null) => {
    const LucideIcon = (Icons as any)[iconName || 'HelpCircle'] || Icons.HelpCircle;
    return <LucideIcon size={28} style={{ color: color || 'var(--primary)' }} />;
  };

  const formatDate = (isoString: string | null) => {
    if (!isoString) return 'Permanent';
    return new Date(isoString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <div>
      {/* Page Navigation */}
      <button
        className="btn btn-outline btn-sm"
        onClick={() => navigate(`/groups?platform=${group.platform}`)}
        style={{ marginBottom: '24px' }}
      >
        <Icons.ChevronLeft size={16} /> Back to Groups
      </button>

      {/* Grid Layout */}
      <div className="detail-grid">
        {/* Left Column: Group Details Card */}
        <div className="detail-card" style={{ borderTop: `5px solid ${group.color || 'var(--primary)'}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div className="group-icon-box" style={{ background: 'var(--primary-light)' }}>
              {renderIcon(group.icon, group.color)}
            </div>
            <h2 style={{ fontSize: '22px' }}>{group.name}</h2>
          </div>

          <p style={{ color: 'var(--text-muted)', fontSize: '14px', whiteSpace: 'pre-wrap' }}>
            {group.description}
          </p>

          <div className="detail-list">
            {group.externalGroupId && (
              <div className="detail-item">
                <span className="detail-label">External Group ID</span>
                <span className="detail-value">{group.externalGroupId}</span>
              </div>
            )}

            <div className="detail-item">
              <span className="detail-label">Access Status</span>
              <div>
                {group.accessStatus === 'ACTIVE' && (
                  <span className="badge badge-approved" style={{ gap: '6px' }}>
                    <Icons.CheckCircle size={12} /> Active Access
                    {group.currentLevelName && ` · ${group.currentLevelName}`}
                  </span>
                )}
                {group.accessStatus === 'PENDING' && (
                  <span className="badge badge-pending">
                    Pending Approval
                  </span>
                )}
                {group.accessStatus === 'AWAITING_SETUP' && (
                  <span
                    className="badge"
                    style={{ gap: '6px', backgroundColor: 'var(--primary-light)', color: 'var(--primary)' }}
                  >
                    <Icons.Clock size={12} /> Awaiting Setup
                  </span>
                )}
                {group.accessStatus === 'NONE' && (
                  <span className="badge badge-revoked">
                    No Access
                  </span>
                )}
              </div>
            </div>

            {/* Permission levels (subgroups) available for this group */}
            {group.levels && group.levels.length > 0 && (
              <div className="detail-item" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
                <span className="detail-label" style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                  <Icons.Layers size={13} style={{ color: 'var(--primary)' }} />
                  Permission Levels
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {group.levels.map((lvl) => (
                    <div key={lvl.id} style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: '13px', fontWeight: 700 }}>
                        {lvl.name}
                        {lvl.permission && (
                          <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '1px 6px' }}>
                            {lvl.permission}
                          </span>
                        )}
                        {group.currentLevelId === lvl.id && (
                          <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: 'var(--primary)' }}>
                            · your level
                          </span>
                        )}
                      </span>
                      {lvl.description && (
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{lvl.description}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tables section inside details */}
            <div className="detail-item" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
              <span className="detail-label" style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                <Icons.Database size={13} style={{ color: 'var(--primary)' }} />
                Accessible Tables
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {group.tables && group.tables.length > 0 ? (
                  group.tables.map((table) => (
                    <span key={table} className="chip">
                      {table}
                    </span>
                  ))
                ) : (
                  <span style={{ fontSize: '13px', color: 'var(--text-light)', fontStyle: 'italic' }}>
                    No tables registered
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Action Trigger */}
          {group.accessStatus === 'NONE' && (
            <button 
              className="btn btn-primary" 
              onClick={() => {
                if (!isPlatformUser) {
                  setIsInviteModalOpen(true);
                } else {
                  setIsRequestModalOpen(true);
                }
              }}
              style={{ width: '100%', marginTop: '12px' }}
            >
              Request Access
            </button>
          )}

          {/* Extend — request more time on a grant the user already holds. Goes
              through admin approval; access keeps working until then. */}
          {group.accessStatus === 'ACTIVE' && (
            <button
              className="btn btn-outline"
              onClick={() => setIsRenewModalOpen(true)}
              style={{ width: '100%', marginTop: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
            >
              <Icons.RotateCw size={16} /> Extend Access
            </button>
          )}

          {/* Approved, but the requester hasn't finished platform-account setup yet.
              Nothing to do here — it activates automatically post-setup, so don't
              offer a (duplicate) Request Access button. */}
          {group.accessStatus === 'AWAITING_SETUP' && (
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '12px', lineHeight: 1.5 }}>
              Your access to this group is <strong>approved</strong>. It will activate
              automatically once you finish setting up your {platformDisplayName(group.platform)} account.
            </p>
          )}

          {/* Group Leads / Admins List */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '20px' }}>
            <h4 style={{ fontSize: '14px', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Icons.Shield size={16} style={{ color: 'var(--primary)' }} />
              Group Administrators
            </h4>
            {group.admins.length === 0 ? (
              <p style={{ fontSize: '13px', color: 'var(--text-light)', fontStyle: 'italic' }}>
                No dedicated admins. Managed by Super Admins.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {group.admins.map((adm) => (
                  <div key={adm.userId} style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: '13px', fontWeight: 700 }}>{adm.userName.replace('_', ' ')}</span>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{adm.userEmail}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Members List */}
        <div>
          <SectionHeader title="Active Group Members" meta={`${group.members.length} Users`} />

          {group.members.length === 0 ? (
            <EmptyState
              icon={<Icons.Users size={40} />}
              title="No Active Members"
              description="There are currently no employees with active access granted to this group."
            />
          ) : (
            <div className="table-container">
              <table className="hermes-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Email</th>
                    {group.levels.length > 0 && <th>Level</th>}
                    <th>Granted</th>
                    <th>Expires</th>
                    {canManage && <th style={{ textAlign: 'right' }}>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {group.members.map((member) => {
                    const memberIsAdmin = adminUserIds.has(member.userId);
                    return (
                    <tr key={member.id}>
                      <td style={{ fontWeight: 700 }}>
                        {member.userName.replace('_', ' ')}
                        {memberIsAdmin && (
                          <span className="badge badge-admin badge-sm" style={{ marginLeft: 8 }}>
                            ADMIN
                          </span>
                        )}
                      </td>
                      <td>{member.userEmail}</td>
                      {group.levels.length > 0 && (
                        <td>
                          {member.levelName ? (
                            <span style={{ fontSize: '12px', fontWeight: 600 }}>{member.levelName}</span>
                          ) : (
                            <span style={{ fontSize: '12px', color: 'var(--text-light)', fontStyle: 'italic' }}>—</span>
                          )}
                        </td>
                      )}
                      <td>{formatDate(member.grantedAt)}</td>
                      <td>
                        <ExpiryBadge expiresAt={member.expiresAt} />
                      </td>
                      {canManage && (
                        <td style={{ textAlign: 'right' }}>
                          {member.userId === user?.id ? (
                            <span style={{ fontSize: '12px', color: 'var(--text-light)', fontStyle: 'italic' }}>
                              Self Access
                            </span>
                          ) : (
                            <button
                              className="btn btn-danger btn-sm"
                              onClick={() => setRevokeTarget({ memberAccessId: member.id, memberName: member.userName.replace('_', ' ') })}
                              disabled={revokingId === member.id}
                            >
                              {revokingId === member.id ? 'Revoking...' : 'Revoke'}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Access Request Modal */}
      {isRequestModalOpen && (
        <AccessRequestModal
          isOpen={isRequestModalOpen}
          onClose={() => setIsRequestModalOpen(false)}
          groupId={group.id}
          groupName={group.name}
          levels={group.levels}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: queryKeys.groupDetail(slug ?? '') });
            queryClient.invalidateQueries({ queryKey: queryKeys.groups() });
            queryClient.invalidateQueries({ queryKey: queryKeys.myRequests() });
          }}
        />
      )}

      {/* Extend / renew access for the grant the user currently holds. */}
      <RenewAccessModal
        isOpen={isRenewModalOpen}
        onClose={() => setIsRenewModalOpen(false)}
        groupId={group.id}
        groupName={group.name}
        currentLevelName={group.currentLevelName}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: queryKeys.groupDetail(slug ?? '') });
          queryClient.invalidateQueries({ queryKey: queryKeys.groups() });
          queryClient.invalidateQueries({ queryKey: queryKeys.myRequests() });
          queryClient.invalidateQueries({ queryKey: queryKeys.myAccess() });
        }}
      />

      {/* Revoke confirmation + reason (replaces window.prompt). */}
      <ReasonModal
        isOpen={!!revokeTarget}
        danger
        title="Revoke access"
        confirmLabel="Revoke"
        placeholder="e.g. No longer on the project…"
        loading={revokeMutation.isPending}
        message={
          revokeTarget
            ? `Revoke ${revokeTarget.memberName}'s access to ${group.name}? This removes them from the group on ${platformDisplayName(group.platform)}.`
            : ''
        }
        onConfirm={(reason) => revokeTarget && revokeMutation.mutate({ memberAccessId: revokeTarget.memberAccessId, reason })}
        onClose={() => setRevokeTarget(null)}
      />

      {/* Platform Invite Modal — routes the user into the account-creation flow when needed. */}
      <PlatformInviteModal
        isOpen={isInviteModalOpen}
        onClose={() => setIsInviteModalOpen(false)}
        platformId={group.platform}
        platformName={platformDisplayName(group.platform)}
        accountStatus={account}
        onSuccess={() => {
          // After submission, the modal closes itself; refetch group data + this
          // platform's account status in case the user's status changed.
          queryClient.invalidateQueries({ queryKey: queryKeys.groupDetail(slug ?? '') });
          queryClient.invalidateQueries({ queryKey: queryKeys.userCreation(group.platform) });
        }}
      />
    </div>
  );
};

export default GroupDetail;
