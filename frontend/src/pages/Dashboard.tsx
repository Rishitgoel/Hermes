import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import apiClient from '../services/apiClient';
import LoadingSpinner from '../components/common/LoadingSpinner';
import AccessRequestModal from '../components/access/AccessRequestModal';
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

export const Dashboard: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  
  const [groups, setGroups] = useState<GroupData[]>([]);
  const [pendingReviewCount, setPendingReviewCount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);
  
  // Modal states
  const [selectedGroup, setSelectedGroup] = useState<{ id: string; name: string } | null>(null);

  const isAdmin = user?.roles.includes('atlas_super_admin') || user?.roles.includes('atlas_group_admin');

  const fetchData = async () => {
    try {
      // 1. Fetch groups with statuses
      const groupsRes = await apiClient.get('/api/groups');
      setGroups(groupsRes.data);

      // 2. Fetch pending reviews if admin
      if (isAdmin) {
        const pendingRes = await apiClient.get('/api/access-requests/pending');
        setPendingReviewCount(pendingRes.data.length);
      }
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [user]);

  if (isLoading) {
    return <LoadingSpinner />;
  }

  // Calculate statistics
  const totalGroups = groups.length;
  const activeAccessCount = groups.filter((g) => g.accessStatus === 'ACTIVE').length;
  const pendingRequestCount = groups.filter((g) => g.accessStatus === 'PENDING').length;

  const renderIcon = (iconName: string | null, color: string | null) => {
    const LucideIcon = (Icons as any)[iconName || 'HelpCircle'] || Icons.HelpCircle;
    return <LucideIcon size={24} style={{ color: color || 'var(--primary)' }} />;
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
        <div className="stat-card" onClick={() => navigate('/my-access')} style={{ cursor: 'pointer' }}>
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

      {/* Groups List */}
      <div className="section-header">
        <h3 className="section-title">Available Data Groups</h3>
        <button className="btn btn-outline" onClick={() => navigate('/groups')}>
          View All Groups <Icons.ArrowRight size={16} />
        </button>
      </div>

      <div className="cards-grid">
        {groups.map((group) => (
          <div 
            key={group.id} 
            className="group-card" 
            style={{ '--card-accent-color': group.color || 'var(--primary)' } as React.CSSProperties}
          >
            <div className="group-card-header">
              <div className="group-icon-box">
                {renderIcon(group.icon, group.color)}
              </div>
              <h4 className="group-card-title">{group.name}</h4>
            </div>

            <p className="group-card-desc">{group.description}</p>

            <div className="group-card-footer">
              <span className="group-members-count">
                <Icons.Users size={16} />
                {group.memberCount} active members
              </span>

              {group.accessStatus === 'ACTIVE' && (
                <button 
                  className="btn btn-secondary" 
                  onClick={() => navigate(`/groups/${group.slug}`)}
                  style={{ gap: '6px' }}
                >
                  <Icons.CheckCircle size={14} /> Active
                </button>
              )}

              {group.accessStatus === 'PENDING' && (
                <button 
                  className="btn btn-outline" 
                  onClick={() => navigate(`/groups/${group.slug}`)}
                  style={{ color: 'var(--status-pending-text)', borderColor: 'var(--status-pending-text)', backgroundColor: 'var(--status-pending-bg)' }}
                >
                  Pending
                </button>
              )}

              {group.accessStatus === 'NONE' && (
                <button 
                  className="btn btn-primary" 
                  onClick={() => setSelectedGroup({ id: group.id, name: group.name })}
                >
                  Request Access
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Request Access Modal */}
      {selectedGroup && (
        <AccessRequestModal
          isOpen={!!selectedGroup}
          onClose={() => setSelectedGroup(null)}
          groupId={selectedGroup.id}
          groupName={selectedGroup.name}
          onSuccess={() => {
            fetchData();
            // Show custom alert if needed, or simply let data refresh
          }}
        />
      )}
    </div>
  );
};

export default Dashboard;
