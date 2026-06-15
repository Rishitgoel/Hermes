import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import apiClient from '../services/apiClient';
import LoadingSpinner from '../components/common/LoadingSpinner';
import EmptyState from '../components/common/EmptyState';
import SectionHeader from '../components/common/SectionHeader';
import ExpiryBadge, { isExpiringSoon } from '../components/common/ExpiryBadge';
import RenewAccessModal from '../components/access/RenewAccessModal';
import { queryKeys } from '../lib/queryKeys';
import { fetchPlatforms } from '../services/api/platforms';
import * as Icons from 'lucide-react';

interface GroupData {
  id: string;
  name: string;
  slug: string;
  description: string;
  icon: string | null;
  color: string | null;
  memberCount: number;
  accessStatus: 'ACTIVE' | 'PENDING' | 'AWAITING_SETUP' | 'NONE';
}

interface ActiveAccessData {
  id: string;
  userId: string;
  userName: string;
  groupId: string;
  grantedAt: string;
  expiresAt: string | null;
  grantedBy: string;
  group: {
    name: string;
    slug: string;
    description: string;
    color: string | null;
    icon: string | null;
    platform: string;
  };
}

export const Dashboard: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const activeAccessRef = useRef<HTMLDivElement>(null);
  const [renewTarget, setRenewTarget] = useState<{ groupId: string; groupName: string } | null>(null);

  const isAdmin = user?.roles.includes('hermes_super_admin') || user?.roles.includes('hermes_group_admin');
  const isSuperAdmin = !!user?.roles.includes('hermes_super_admin');

  const accessesQuery = useQuery<ActiveAccessData[]>({
    queryKey: queryKeys.myAccess(),
    queryFn: () => apiClient.get('/api/user-access/me').then((r) => r.data),
  });

  const groupsQuery = useQuery<GroupData[]>({
    queryKey: queryKeys.groups(),
    queryFn: () => apiClient.get('/api/groups').then((r) => r.data),
  });

  const pendingQuery = useQuery<unknown[]>({
    queryKey: queryKeys.pendingRequests(),
    queryFn: () => apiClient.get('/api/access-requests/pending').then((r) => r.data),
    enabled: !!isAdmin,
  });

  // Live platforms (adapter-owned displayName + launchUrl) so each grant links to
  // its own platform instead of a single hardcoded one.
  const platformsQuery = useQuery({
    queryKey: queryKeys.platforms(),
    queryFn: fetchPlatforms,
  });

  // Recent provision failures (last 7 days) — the audit route is super-admin
  // gated, so this query must never fire for other roles.
  const failuresFromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const failuresQuery = useQuery<number>({
    queryKey: queryKeys.audit({ page: 1, pageSize: 5, action: 'PROVISION_FAILED', search: '', fromDate: failuresFromDate }),
    queryFn: async () => {
      const res = await apiClient.get('/api/audit', {
        headers: { pageno: '1', pagesize: '5' },
        params: { action: 'PROVISION_FAILED', fromDate: failuresFromDate },
      });
      const items = (res.data ?? []) as unknown[];
      return Number(res.headers['total']) || items.length;
    },
    enabled: isSuperAdmin,
  });
  const provisionFailureCount = failuresQuery.data ?? 0;

  const accesses = accessesQuery.data ?? [];
  const groups = groupsQuery.data ?? [];
  const pendingReviewCount = pendingQuery.data?.length ?? 0;
  const platformsByKey = new Map((platformsQuery.data ?? []).map((p) => [p.key, p]));

  const isLoading =
    accessesQuery.isLoading ||
    groupsQuery.isLoading ||
    (isAdmin && pendingQuery.isLoading);

  if (isLoading) {
    return <LoadingSpinner />;
  }

  // Calculate statistics
  const activeAccessCount = accesses.length;
  const pendingRequestCount = groups.filter(
    (g) => g.accessStatus === 'PENDING' || g.accessStatus === 'AWAITING_SETUP',
  ).length;
  const expiringSoonCount = accesses.filter((a) => isExpiringSoon(a.expiresAt)).length;

  const formatDate = (isoString: string) => {
    return new Date(isoString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const renderIcon = (iconName: string | null, color: string | null, size = 24) => {
    const LucideIcon = (Icons as any)[iconName || 'ShieldCheck'] || Icons.ShieldCheck;
    return <LucideIcon size={size} style={{ color: color || 'var(--primary)' }} />;
  };

  return (
    <div>
      {/* Welcome Banner */}
      <div className="welcome-banner">
        <h1 style={{ fontSize: '32px', color: 'white' }}>
          Welcome back, {user?.username.split('_').join(' ')}!
        </h1>
        <p>
          Manage your database permissions, request data access, and review pending credentials from a central dashboard.
        </p>
      </div>

      {/* Statistics Row */}
      <div className="stats-grid">
        <div 
          className="stat-card" 
          onClick={() => activeAccessRef.current?.scrollIntoView({ behavior: 'smooth' })} 
          style={{ cursor: 'pointer' }}
        >
          <div className="stat-icon-wrapper">
            <Icons.ShieldCheck size={26} />
          </div>
          <div className="stat-info">
            <span className="stat-value">{activeAccessCount}</span>
            <span className="stat-label">Active Accesses</span>
          </div>
        </div>

        <div className="stat-card" onClick={() => navigate('/my-requests')} style={{ cursor: 'pointer' }}>
          <div className="stat-icon-wrapper">
            <Icons.FileClock size={26} />
          </div>
          <div className="stat-info">
            <span className="stat-value">{pendingRequestCount}</span>
            <span className="stat-label">Pending Requests</span>
          </div>
        </div>

        {expiringSoonCount > 0 && (
          <div
            className="stat-card stat-card-warning"
            onClick={() => activeAccessRef.current?.scrollIntoView({ behavior: 'smooth' })}
            style={{ cursor: 'pointer' }}
            title="Grants expiring within 7 days — use Extend in the table below"
          >
            <div className="stat-icon-wrapper" style={{ backgroundColor: 'var(--status-pending-bg)', color: 'var(--status-pending-text)' }}>
              <Icons.Hourglass size={26} />
            </div>
            <div className="stat-info">
              <span className="stat-value" style={{ color: 'var(--status-pending-text)' }}>{expiringSoonCount}</span>
              <span className="stat-label">Expiring Soon</span>
            </div>
          </div>
        )}

        {isAdmin && (
          <div className="stat-card" onClick={() => navigate('/pending-approvals')} style={{ cursor: 'pointer', borderLeft: '4px solid var(--secondary)' }}>
            <div className="stat-icon-wrapper" style={{ backgroundColor: 'var(--primary-light)', color: 'var(--secondary)' }}>
              <Icons.CheckSquare size={26} />
            </div>
            <div className="stat-info">
              <span className="stat-value" style={{ color: 'var(--secondary)' }}>{pendingReviewCount}</span>
              <span className="stat-label">Approvals Pending</span>
            </div>
          </div>
        )}

        {isSuperAdmin && provisionFailureCount > 0 && (
          <div
            className="stat-card stat-card-danger"
            onClick={() => navigate('/audit-log')}
            style={{ cursor: 'pointer' }}
            title="PROVISION_FAILED audit entries in the last 7 days"
          >
            <div className="stat-icon-wrapper" style={{ backgroundColor: 'var(--status-rejected-bg)', color: 'var(--status-rejected-text)' }}>
              <Icons.AlertTriangle size={26} />
            </div>
            <div className="stat-info">
              <span className="stat-value" style={{ color: 'var(--status-rejected-text)' }}>{provisionFailureCount}</span>
              <span className="stat-label">Provision Failures (7d)</span>
            </div>
          </div>
        )}
      </div>

      {/* My Active Access */}
      <div ref={activeAccessRef} style={{ scrollMarginTop: '20px' }}>
        <SectionHeader title="My Active Access" meta={`${accesses.length} Active Grants`} />
      </div>

      {accesses.length === 0 ? (
        <EmptyState
          icon={<Icons.ShieldCheck size={40} />}
          title="No Active Access"
          description="You do not currently hold active permissions for any data groups. Browse data groups to submit access requests."
          action={
            <button className="btn btn-primary" onClick={() => navigate('/groups')}>
              Browse Groups
            </button>
          }
        />
      ) : (
        <div className="table-container">
          <table className="hermes-table hermes-table-compact">
            <thead>
              <tr>
                <th>Group Name</th>
                <th style={{ width: '220px' }}>Expiry Status</th>
                <th style={{ width: '180px', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {accesses.map((access) => (
                <tr key={access.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div className="group-icon-box" style={{ width: '32px', height: '32px', borderRadius: '6px', flexShrink: 0, background: 'var(--primary-light)' }}>
                        {renderIcon(access.group.icon, access.group.color, 18)}
                      </div>
                      <span 
                        style={{ 
                          fontWeight: 700, 
                          color: 'var(--text-main)', 
                          cursor: 'pointer',
                          fontSize: '15px'
                        }}
                        onClick={() => navigate(`/groups/${access.group.slug}`)}
                      >
                        {access.group.name}
                      </span>
                      
                      <div className="info-tooltip-container">
                        <Icons.Info size={14} />
                        <div className="info-tooltip">
                          <strong style={{ display: 'block', marginBottom: '4px', fontSize: '13px', color: 'var(--primary)' }}>
                            Access Details
                          </strong>
                          <div style={{ marginBottom: '6px' }}>{access.group.description}</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-light)', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '6px', marginTop: '6px' }}>
                            Granted by: <strong>{access.grantedBy}</strong> on {formatDate(access.grantedAt)}
                          </div>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <ExpiryBadge expiresAt={access.expiresAt} />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                      {isExpiringSoon(access.expiresAt) && (
                        <button
                          className="btn btn-outline btn-sm"
                          title="Request an extension for this group"
                          onClick={() => setRenewTarget({ groupId: access.groupId, groupName: access.group.name })}
                        >
                          <Icons.RotateCw size={12} /> Extend
                        </button>
                      )}
                      <button
                        className="btn btn-outline btn-sm"
                        onClick={() => navigate(`/groups/${access.group.slug}`)}
                      >
                        Details
                      </button>
                      {(() => {
                        const plat = platformsByKey.get(access.group.platform);
                        return plat?.launchUrl ? (
                          <a
                            href={plat.launchUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-primary btn-sm"
                          >
                            {plat.displayName} <Icons.ExternalLink size={11} />
                          </a>
                        ) : null;
                      })()}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Extend / renew access for an expiring grant. */}
      {renewTarget && (
        <RenewAccessModal
          isOpen={!!renewTarget}
          onClose={() => setRenewTarget(null)}
          groupId={renewTarget.groupId}
          groupName={renewTarget.groupName}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: queryKeys.myAccess() });
            queryClient.invalidateQueries({ queryKey: queryKeys.myRequests() });
            queryClient.invalidateQueries({ queryKey: queryKeys.pendingRequests() });
          }}
        />
      )}
    </div>
  );
};

export default Dashboard;
