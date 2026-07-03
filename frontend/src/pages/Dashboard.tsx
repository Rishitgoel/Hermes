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
import { getMyUserCreations } from '../services/api/userCreation';
import * as Icons from 'lucide-react';
import { platformDisplayName } from '../lib/platforms';

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
  level: { id: string; name: string } | null;
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

  // Per-platform account-creation status for the current user, so the dashboard can
  // show where the user can (and can't yet) request access.
  const accountsQuery = useQuery({
    queryKey: queryKeys.userCreations(),
    queryFn: getMyUserCreations,
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
  const livePlatforms = platformsQuery.data ?? [];
  const accountByPlatform = new Map((accountsQuery.data ?? []).map((a) => [a.platform, a]));

  // Group active grants by platform so the access list is platform-aware instead of a
  // single undifferentiated table. Sorted by platform label for a stable order.
  const accessesByPlatform = accesses.reduce<Record<string, ActiveAccessData[]>>((acc, a) => {
    (acc[a.group.platform] ??= []).push(a);
    return acc;
  }, {});
  const platformGroups = Object.entries(accessesByPlatform).sort((a, b) =>
    platformDisplayName(a[0]).localeCompare(platformDisplayName(b[0])),
  );

  // "Redash 2 · AWS 1" — makes the bare Active Accesses count meaningful at a glance.
  const accessBreakdown = platformGroups.map(([key, list]) => `${platformDisplayName(key)} ${list.length}`).join(' · ');

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

  // Resolve the account-creation status for a platform into a chip: copy, colour, and
  // (optionally) a click action. Drives the "My Platform Accounts" strip — it tells the
  // user where they already have an account vs. where one is pending or not yet requested.
  const accountChip = (
    platformKey: string,
  ): { label: string; color: string; bg: string; onClick?: () => void } => {
    const req = accountByPlatform.get(platformKey);
    switch (req?.status) {
      case 'COMPLETED':
        return { label: 'Active', color: 'var(--status-approved-text)', bg: 'var(--status-approved-bg)' };
      case 'AWAITING_SETUP':
        return {
          label: 'Create password',
          color: 'var(--status-pending-text)',
          bg: 'var(--status-pending-bg)',
          onClick: () => navigate('/my-requests'),
        };
      case 'PENDING':
      case 'APPROVED':
        return { label: 'Pending approval', color: 'var(--status-pending-text)', bg: 'var(--status-pending-bg)' };
      case 'REJECTED':
        return { label: 'Rejected', color: 'var(--status-rejected-text)', bg: 'var(--status-rejected-bg)' };
      default:
        return { label: 'Not requested', color: 'var(--text-light)', bg: 'var(--bg-app)' };
    }
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
            {accessBreakdown && (
              <span style={{ fontSize: '11px', color: 'var(--text-light)', marginTop: '2px' }}>{accessBreakdown}</span>
            )}
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

      {/* My Platform Accounts — where the user has an account vs. where one is pending /
          not yet requested. Access can only be granted on a platform the user has an
          account on, so this is the first thing worth knowing. */}
      {livePlatforms.length > 0 && (
        <>
          <SectionHeader title="My Platform Accounts" meta={`${livePlatforms.length} platform(s)`} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '8px' }}>
            {livePlatforms.map((p) => {
              const chip = accountChip(p.key);
              const isActive = accountByPlatform.get(p.key)?.status === 'COMPLETED';
              return (
                <div
                  key={p.key}
                  className="stat-card"
                  style={{ flex: '1 1 200px', minWidth: '200px', cursor: chip.onClick ? 'pointer' : 'default' }}
                  onClick={chip.onClick}
                >
                  <div className="stat-icon-wrapper" style={{ backgroundColor: chip.bg, color: chip.color }}>
                    <Icons.Server size={22} />
                  </div>
                  <div className="stat-info" style={{ flex: 1 }}>
                    <span style={{ fontWeight: 700, color: 'var(--text-main)', fontSize: '15px' }}>{p.displayName}</span>
                    <span style={{ fontSize: '12px', fontWeight: 700, color: chip.color }}>{chip.label}</span>
                  </div>
                  {isActive && p.launchUrl && (
                    <a
                      href={p.launchUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-outline btn-sm"
                      onClick={(e) => e.stopPropagation()}
                      title={`Open ${p.displayName}`}
                    >
                      <Icons.ExternalLink size={13} />
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* My Active Access — grouped by platform so each grant is unambiguous about
          which system it applies to, with the platform's own launch link. */}
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
        platformGroups.map(([platformKey, platformAccesses]) => {
          const plat = livePlatforms.find((p) => p.key === platformKey);
          return (
            <div key={platformKey} style={{ marginBottom: '24px' }}>
              {/* Platform section header: name + grant count + launch link. */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '8px 4px',
                  marginBottom: '8px',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <Icons.Server size={16} style={{ color: 'var(--primary)' }} />
                <span style={{ fontWeight: 700, color: 'var(--text-main)' }}>{platformDisplayName(platformKey)}</span>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>
                  {platformAccesses.length} grant(s)
                </span>
                {plat?.launchUrl && (
                  <a
                    href={plat.launchUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-primary btn-sm"
                    style={{ marginLeft: 'auto' }}
                  >
                    Open {plat.displayName} <Icons.ExternalLink size={11} />
                  </a>
                )}
              </div>

              <div className="table-container">
                <table className="hermes-table hermes-table-compact">
                  <thead>
                    <tr>
                      <th>Group</th>
                      <th style={{ width: '140px' }}>Level</th>
                      <th style={{ width: '200px' }}>Expiry Status</th>
                      <th style={{ width: '160px', textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {platformAccesses.map((access) => (
                      <tr key={access.id}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <div className="group-icon-box" style={{ width: '32px', height: '32px', borderRadius: '6px', flexShrink: 0, background: 'var(--primary-light)' }}>
                              {renderIcon(access.group.icon, access.group.color, 18)}
                            </div>
                            <span
                              style={{ fontWeight: 700, color: 'var(--text-main)', cursor: 'pointer', fontSize: '15px' }}
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
                          {access.level ? (
                            <span className="badge badge-active badge-sm">{access.level.name}</span>
                          ) : (
                            <span style={{ color: 'var(--text-light)', fontSize: '13px' }}>—</span>
                          )}
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
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })
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
