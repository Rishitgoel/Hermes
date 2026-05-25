import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
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

export const Groups: React.FC = () => {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<GroupData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Modal state
  const [selectedGroup, setSelectedGroup] = useState<{ id: string; name: string } | null>(null);

  const fetchGroups = async () => {
    try {
      const res = await apiClient.get('/api/groups');
      setGroups(res.data);
    } catch (err) {
      console.error('Failed to fetch groups:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchGroups();
  }, []);

  if (isLoading) {
    return <LoadingSpinner />;
  }

  // Filter groups
  const filteredGroups = groups.filter((g) =>
    g.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    g.description.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const renderIcon = (iconName: string | null, color: string | null) => {
    const LucideIcon = (Icons as any)[iconName || 'HelpCircle'] || Icons.HelpCircle;
    return <LucideIcon size={24} style={{ color: color || 'var(--primary)' }} />;
  };

  return (
    <div>
      {/* Page Header */}
      <div className="section-header">
        <h1 style={{ fontSize: '28px', fontFamily: 'Outfit, sans-serif' }}>Data Groups</h1>
        
        {/* Search Bar */}
        <div style={{ position: 'relative', width: '300px' }}>
          <Icons.Search 
            size={18} 
            style={{
              position: 'absolute',
              top: '12px',
              left: '16px',
              color: 'var(--text-light)'
            }} 
          />
          <input
            type="text"
            className="form-input"
            placeholder="Search groups..."
            style={{ paddingLeft: '44px' }}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {filteredGroups.length === 0 ? (
        <div className="empty-state">
          <Icons.Search size={44} className="empty-state-icon" />
          <h3 className="empty-state-title">No Groups Found</h3>
          <p className="empty-state-desc">We couldn't find any data groups matching your search term. Try searching for other keywords.</p>
        </div>
      ) : (
        <div className="cards-grid">
          {filteredGroups.map((group) => (
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
                <span className="group-members-count" onClick={() => navigate(`/groups/${group.slug}`)} style={{ cursor: 'pointer', textDecoration: 'underline' }}>
                  <Icons.Users size={16} />
                  {group.memberCount} active members
                </span>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button 
                    className="btn btn-outline"
                    onClick={() => navigate(`/groups/${group.slug}`)}
                  >
                    Details
                  </button>

                  {group.accessStatus === 'ACTIVE' && (
                    <button 
                      className="btn btn-secondary" 
                      disabled
                      style={{ gap: '6px' }}
                    >
                      <Icons.CheckCircle size={14} /> Active
                    </button>
                  )}

                  {group.accessStatus === 'PENDING' && (
                    <button 
                      className="btn btn-outline" 
                      disabled
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
                      Request
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Access Request Modal */}
      {selectedGroup && (
        <AccessRequestModal
          isOpen={!!selectedGroup}
          onClose={() => setSelectedGroup(null)}
          groupId={selectedGroup.id}
          groupName={selectedGroup.name}
          onSuccess={fetchGroups}
        />
      )}
    </div>
  );
};

export default Groups;
