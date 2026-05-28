import React, { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import apiClient from '../services/apiClient';
import LoadingSpinner from '../components/common/LoadingSpinner';
import { queryKeys } from '../lib/queryKeys';
import * as Icons from 'lucide-react';

interface GroupData {
  id: string;
  name: string;
  slug: string;
  description: string;
  icon: string | null;
  color: string | null;
  memberCount: number;
  accessStatus: 'ACTIVE' | 'PENDING' | 'NONE';
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
  };
}

export const Dashboard: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();

  const activeAccessRef = useRef<HTMLDivElement>(null);

  const isAdmin = user?.roles.includes('hermes_super_admin') || user?.roles.includes('hermes_group_admin');

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

  const accesses = accessesQuery.data ?? [];
  const groups = groupsQuery.data ?? [];
  const pendingReviewCount = pendingQuery.data?.length ?? 0;

  const isLoading =
    accessesQuery.isLoading ||
    groupsQuery.isLoading ||
    (isAdmin && pendingQuery.isLoading);

  if (isLoading) {
    return <LoadingSpinner />;
  }

  // Calculate statistics
  const totalGroups = groups.length;
  const activeAccessCount = accesses.length;
  const pendingRequestCount = groups.filter((g) => g.accessStatus === 'PENDING').length;

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

  const getRedashUrl = () => {
    return import.meta.env.VITE_REDASH_URL || 'https://redash.bachatt.app';
  };

  return (
    <div>
      {/* Welcome Banner */}
      <div style={{
        background: 'linear-gradient(135deg, var(--primary), var(--secondary))',
        color: 'white',
        padding: '32px',
        borderRadius: 'var(--radius-lg)',
        marginBottom: '32px',
        boxShadow: 'var(--shadow-md)',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px'
      }}>
        <h1 style={{ fontSize: '32px', fontFamily: 'Outfit, sans-serif', color: 'white' }}>
          Welcome back, {user?.username.split('_').join(' ')}!
        </h1>
        <p style={{ opacity: 0.9, fontSize: '15px', fontWeight: 500 }}>
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

        {isAdmin ? (
          <div className="stat-card" onClick={() => navigate('/pending-approvals')} style={{ cursor: 'pointer', borderLeft: '4px solid var(--secondary)' }}>
            <div className="stat-icon-wrapper" style={{ backgroundColor: 'var(--primary-light)', color: 'var(--secondary)' }}>
              <Icons.CheckSquare size={26} />
            </div>
            <div className="stat-info">
              <span className="stat-value" style={{ color: 'var(--secondary)' }}>{pendingReviewCount}</span>
              <span className="stat-label">Approvals Pending</span>
            </div>
          </div>
        ) : (
          <div className="stat-card" onClick={() => navigate('/groups')} style={{ cursor: 'pointer' }}>
            <div className="stat-icon-wrapper">
              <Icons.Layers size={26} />
            </div>
            <div className="stat-info">
              <span className="stat-value">{totalGroups}</span>
              <span className="stat-label">Total Groups</span>
            </div>
          </div>
        )}
      </div>

      {/* My Active Access */}
      <div className="section-header" ref={activeAccessRef} style={{ scrollMarginTop: '20px' }}>
        <h3 className="section-title">My Active Access</h3>
        <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 700 }}>
          {accesses.length} Active Grants
        </span>
      </div>

      {accesses.length === 0 ? (
        <div className="empty-state">
          <Icons.ShieldCheck size={44} className="empty-state-icon" />
          <h3 className="empty-state-title">No Active Access</h3>
          <p className="empty-state-desc">You do not currently hold active permissions for any data groups. Browse data groups to submit access requests.</p>
          <button className="btn btn-primary" onClick={() => navigate('/groups?platform=redash')}>
            Browse Groups
          </button>
        </div>
      ) : (
        <div className="table-container">
          <table className="hermes-table">
            <thead>
              <tr>
                <th style={{ padding: '12px 24px' }}>Group Name</th>
                <th style={{ width: '220px', padding: '12px 24px' }}>Expiry Status</th>
                <th style={{ width: '180px', textAlign: 'right', padding: '12px 24px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {accesses.map((access) => (
                <tr key={access.id}>
                  <td style={{ padding: '12px 24px' }}>
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
                          <strong style={{ display: 'block', marginBottom: '4px', fontSize: '13px', color: 'var(--primary-light)' }}>
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
                  <td style={{ padding: '12px 24px' }}>
                    {access.expiresAt ? (
                      <span className="badge badge-pending" style={{ gap: '4px', backgroundColor: 'hsl(38, 92%, 94%)', color: 'hsl(32, 85%, 33%)', padding: '4px 8px', fontSize: '12px' }}>
                        <Icons.Clock size={12} /> Expires {formatDate(access.expiresAt)}
                      </span>
                    ) : (
                      <span className="badge badge-approved" style={{ gap: '4px', padding: '4px 8px', fontSize: '12px' }}>
                        <Icons.CheckCircle2 size={12} /> Permanent Access
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', padding: '12px 24px' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                      <button 
                        className="btn btn-outline"
                        style={{ padding: '4px 10px', fontSize: '11px', height: '30px' }}
                        onClick={() => navigate(`/groups/${access.group.slug}`)}
                      >
                        Details
                      </button>
                      <a 
                        href={getRedashUrl()} 
                        target="_blank" 
                        rel="noreferrer" 
                        className="btn btn-primary"
                        style={{ padding: '4px 10px', fontSize: '11px', gap: '4px', height: '30px', display: 'inline-flex', alignItems: 'center' }}
                      >
                        Redash <Icons.ExternalLink size={11} />
                      </a>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
