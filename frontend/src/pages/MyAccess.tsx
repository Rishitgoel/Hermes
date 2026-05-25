import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient from '../services/apiClient';
import LoadingSpinner from '../components/common/LoadingSpinner';
import { ShieldCheck, ExternalLink, Calendar, UserCheck } from 'lucide-react';

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

export const MyAccess: React.FC = () => {
  const [accesses, setAccesses] = useState<ActiveAccessData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    const fetchAccess = async () => {
      try {
        const res = await apiClient.get('/api/user-access/me');
        setAccesses(res.data);
      } catch (err) {
        console.error('Failed to fetch active accesses:', err);
      } finally {
        setIsLoading(false);
      }
    };
    fetchAccess();
  }, []);

  if (isLoading) {
    return <LoadingSpinner />;
  }

  const formatDate = (isoString: string) => {
    return new Date(isoString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const getRedashUrl = () => {
    return import.meta.env.VITE_REDASH_URL || 'https://redash.bachatt.app';
  };

  return (
    <div>
      <div className="section-header">
        <h1 style={{ fontSize: '28px', fontFamily: 'Outfit, sans-serif' }}>My Active Access</h1>
        <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 700 }}>
          {accesses.length} Active Grants
        </span>
      </div>

      {accesses.length === 0 ? (
        <div className="empty-state">
          <ShieldCheck size={44} className="empty-state-icon" />
          <h3 className="empty-state-title">No Active Access</h3>
          <p className="empty-state-desc">You do not currently hold active permissions for any data groups. Browse data groups to submit access requests.</p>
          <button className="btn btn-primary" onClick={() => navigate('/groups')}>
            Browse Groups
          </button>
        </div>
      ) : (
        <div className="cards-grid">
          {accesses.map((access) => (
            <div 
              key={access.id} 
              className="group-card"
              style={{ 
                '--card-accent-color': access.group.color || 'var(--primary)',
                minHeight: '260px'
              } as React.CSSProperties}
            >
              <div className="group-card-header">
                <div className="group-icon-box" style={{ background: 'var(--primary-light)' }}>
                  <ShieldCheck size={24} style={{ color: access.group.color || 'var(--primary)' }} />
                </div>
                <h4 className="group-card-title">{access.group.name}</h4>
              </div>

              <p className="group-card-desc">{access.group.description}</p>

              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                fontSize: '12px',
                color: 'var(--text-muted)',
                marginBottom: '20px',
                paddingTop: '12px',
                borderTop: '1px solid var(--border)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <UserCheck size={14} style={{ color: 'var(--text-light)' }} />
                  <span>Granted by: <strong>{access.grantedBy}</strong> on {formatDate(access.grantedAt)}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Calendar size={14} style={{ color: 'var(--text-light)' }} />
                  <span>
                    Expires: {access.expiresAt ? (
                      <strong style={{ color: '#b7791f' }}>{formatDate(access.expiresAt)}</strong>
                    ) : (
                      <strong style={{ color: 'var(--primary)' }}>Permanent</strong>
                    )}
                  </span>
                </div>
              </div>

              <div className="group-card-footer" style={{ borderTop: 'none', paddingTop: 0 }}>
                <button 
                  className="btn btn-outline" 
                  onClick={() => navigate(`/groups/${access.group.slug}`)}
                >
                  View Details
                </button>
                <a 
                  href={getRedashUrl()} 
                  target="_blank" 
                  rel="noreferrer" 
                  className="btn btn-primary"
                  style={{ gap: '6px' }}
                >
                  Go to Redash <ExternalLink size={14} />
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MyAccess;
