import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import apiClient from '../services/apiClient';
import LoadingSpinner from '../components/common/LoadingSpinner';
import AccessRequestModal from '../components/access/AccessRequestModal';
import PlatformInviteModal from '../components/access/PlatformInviteModal';
import * as Icons from 'lucide-react';

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
}

interface GroupDetailData {
  id: string;
  name: string;
  slug: string;
  description: string;
  icon: string | null;
  color: string | null;
  externalGroupId: string | null;
  accessStatus: 'ACTIVE' | 'PENDING' | 'NONE';
  admins: GroupAdmin[];
  members: GroupMember[];
  tables: string[];
}

export const GroupDetail: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [group, setGroup] = useState<GroupDetailData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRequestModalOpen, setIsRequestModalOpen] = useState(false);

  // Platform safeguards
  const [isPlatformUser, setIsPlatformUser] = useState(true);
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);

  // Revoke state
  const [isRevoking, setIsRevoking] = useState<string | null>(null);

  const checkPlatformStatus = async () => {
    try {
      const res = await apiClient.get('/api/user-access/platform-status/redash');
      setIsPlatformUser(res.data.exists);
    } catch (err) {
      console.error('Failed to check platform status:', err);
      setIsPlatformUser(false);
    }
  };

  const fetchGroupDetail = async () => {
    try {
      const res = await apiClient.get(`/api/groups/${slug}`);
      setGroup(res.data);
    } catch (err) {
      console.error('Failed to fetch group details:', err);
      navigate('/groups?platform=redash');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchGroupDetail();
    checkPlatformStatus();
  }, [slug]);

  const handleRevoke = async (memberAccessId: string, memberName: string) => {
    const reason = window.prompt(`Are you sure you want to revoke access for ${memberName}? Enter a reason:`);
    if (reason === null) return; // cancelled

    setIsRevoking(memberAccessId);
    try {
      await apiClient.delete(`/api/user-access/${memberAccessId}`, {
        data: { reason: reason || 'Revoked manually by administrator' },
      });
      fetchGroupDetail();
    } catch (err: any) {
      alert(`Failed to revoke access: ${err.message}`);
    } finally {
      setIsRevoking(null);
    }
  };

  if (isLoading || !group) {
    return <LoadingSpinner />;
  }

  const isSuperAdmin = user?.roles.includes('atlas_super_admin') || false;
  const isGroupAdminOfThisGroup = group.admins.some((adm) => adm.userId === user?.id);
  const canManage = isSuperAdmin || isGroupAdminOfThisGroup;

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
        className="btn btn-outline" 
        onClick={() => navigate('/groups?platform=redash')} 
        style={{ marginBottom: '24px', padding: '6px 12px' }}
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
                <span className="detail-label">Redash Group ID</span>
                <span className="detail-value">{group.externalGroupId}</span>
              </div>
            )}

            <div className="detail-item">
              <span className="detail-label">Access Status</span>
              <div>
                {group.accessStatus === 'ACTIVE' && (
                  <span className="badge badge-approved" style={{ gap: '6px' }}>
                    <Icons.CheckCircle size={12} /> Active Access
                  </span>
                )}
                {group.accessStatus === 'PENDING' && (
                  <span className="badge badge-pending">
                    Pending Approval
                  </span>
                )}
                {group.accessStatus === 'NONE' && (
                  <span className="badge badge-revoked">
                    No Access
                  </span>
                )}
              </div>
            </div>

            {/* Tables section inside details */}
            <div className="detail-item" style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
              <span className="detail-label" style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                <Icons.Database size={13} style={{ color: 'var(--primary)' }} />
                Accessible Tables
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {group.tables && group.tables.length > 0 ? (
                  group.tables.map((table) => (
                    <span 
                      key={table} 
                      style={{
                        fontSize: '12px',
                        fontWeight: 700,
                        backgroundColor: 'var(--primary-light)',
                        color: 'var(--primary)',
                        padding: '4px 10px',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-focus)',
                        fontFamily: 'monospace',
                        letterSpacing: '0.02em'
                      }}
                    >
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
          <div className="section-header">
            <h3 className="section-title">Active Group Members</h3>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 700 }}>
              {group.members.length} Users
            </span>
          </div>

          {group.members.length === 0 ? (
            <div className="empty-state">
              <Icons.Users size={44} className="empty-state-icon" />
              <h3 className="empty-state-title">No Active Members</h3>
              <p className="empty-state-desc">There are currently no employees with active access granted to this group.</p>
            </div>
          ) : (
            <div className="table-container">
              <table className="atlas-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Email</th>
                    <th>Granted</th>
                    <th>Expires</th>
                    {canManage && <th style={{ textAlign: 'right' }}>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {group.members.map((member) => (
                    <tr key={member.id}>
                      <td style={{ fontWeight: 700 }}>{member.userName.replace('_', ' ')}</td>
                      <td>{member.userEmail}</td>
                      <td>{formatDate(member.grantedAt)}</td>
                      <td>
                        {member.expiresAt ? (
                          <span style={{ color: '#b7791f', fontWeight: 600 }}>
                            {formatDate(member.expiresAt)}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--primary)', fontWeight: 700 }}>
                            Permanent
                          </span>
                        )}
                      </td>
                      {canManage && (
                        <td style={{ textAlign: 'right' }}>
                          {member.userId === user?.id ? (
                            <span style={{ fontSize: '12px', color: 'var(--text-light)', fontStyle: 'italic' }}>
                              Self Access
                            </span>
                          ) : (
                            <button
                              className="btn btn-danger"
                              style={{ padding: '6px 12px', fontSize: '12px' }}
                              onClick={() => handleRevoke(member.id, member.userName)}
                              disabled={isRevoking === member.id}
                            >
                              {isRevoking === member.id ? 'Revoking...' : 'Revoke'}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
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
          onSuccess={fetchGroupDetail}
        />
      )}

      {/* Platform Invite Modal */}
      <PlatformInviteModal
        isOpen={isInviteModalOpen}
        onClose={() => setIsInviteModalOpen(false)}
        platformId="redash"
        platformName="Redash"
        onSuccess={() => {
          checkPlatformStatus();
        }}
      />
    </div>
  );
};

export default GroupDetail;
