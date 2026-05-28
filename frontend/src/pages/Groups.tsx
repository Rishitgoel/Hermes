import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import apiClient from '../services/apiClient';
import LoadingSpinner from '../components/common/LoadingSpinner';
import PlatformInviteModal from '../components/access/PlatformInviteModal';
import * as Icons from 'lucide-react';
import { queryKeys } from '../lib/queryKeys';

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

interface PlatformMetadata {
  id: string;
  name: string;
  fullName: string;
  description: string;
  iconName: string;
  color: string;
  status: 'ACTIVE' | 'COMING_SOON';
}

const PLATFORMS: PlatformMetadata[] = [
  {
    id: 'redash',
    name: 'Redash',
    fullName: 'Redash Analytics Platform',
    description: 'Data querying, dashboards, database visualization, and schema access management.',
    iconName: 'Database',
    color: '#E0402C',
    status: 'ACTIVE',
  },
  {
    id: 'aws',
    name: 'AWS',
    fullName: 'Amazon Web Services',
    description: 'Cloud infrastructure resources, IAM policies, and VPC access permissions.',
    iconName: 'Cloud',
    color: '#FF9900',
    status: 'COMING_SOON',
  },
  {
    id: 'jira',
    name: 'Jira',
    fullName: 'Jira Software',
    description: 'Project tracking, issue management, and board administrator credentials.',
    iconName: 'Trello',
    color: '#0052CC',
    status: 'COMING_SOON',
  },
  {
    id: 'grafana',
    name: 'Grafana',
    fullName: 'Grafana Dashboards',
    description: 'Metrics monitoring, alert channels, and log visualization permissions.',
    iconName: 'Activity',
    color: '#FADE2A',
    status: 'COMING_SOON',
  },
  {
    id: 'azure',
    name: 'Azure',
    fullName: 'Microsoft Azure Cloud',
    description: 'Subscription management, active directory controls, and cloud resources.',
    iconName: 'Server',
    color: '#0078D4',
    status: 'COMING_SOON',
  },
  {
    id: 'github',
    name: 'GitHub',
    fullName: 'GitHub Repositories',
    description: 'Source code repositories, organization roles, and branch protection bypasses.',
    iconName: 'Github',
    color: '#24292E',
    status: 'COMING_SOON',
  },
  {
    id: 'gcp',
    name: 'GCP',
    fullName: 'Google Cloud Platform',
    description: 'GCP projects, service accounts, and BigQuery database roles.',
    iconName: 'Globe',
    color: '#4285F4',
    status: 'COMING_SOON',
  },
  {
    id: 'apollo',
    name: 'Apollo',
    fullName: 'Apollo GraphQL Studio',
    description: 'GraphQL schemas, federated graphs, and schema registry write access.',
    iconName: 'Radio',
    color: '#112340',
    status: 'COMING_SOON',
  },
];

export const Groups: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const activePlatform = searchParams.get('platform');

  const [searchQuery, setSearchQuery] = useState('');
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  // Platform Safeguards
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);

  // Bulk Request States
  const [selectedGroups, setSelectedGroups] = useState<Record<string, boolean>>({});
  const [customReasons, setCustomReasons] = useState<Record<string, string>>({});
  const [generalReason, setGeneralReason] = useState('');
  const [selectedDuration, setSelectedDuration] = useState('PERMANENT');
  const [activePopupGroupId, setActivePopupGroupId] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkSuccess, setBulkSuccess] = useState<string | null>(null);

  // Custom reason popup state (temporary input before clicking "Save")
  const [tempReason, setTempReason] = useState('');

  const groupsQuery = useQuery<GroupData[]>({
    queryKey: queryKeys.groups(),
    queryFn: () => apiClient.get('/api/groups').then((r) => r.data),
  });

  const platformStatusQuery = useQuery<{ exists: boolean }>({
    queryKey: queryKeys.platformStatus(activePlatform ?? ''),
    queryFn: () =>
      apiClient.get(`/api/user-access/platform-status/${activePlatform}`).then((r) => r.data),
    enabled: !!activePlatform,
  });

  const groups = groupsQuery.data ?? [];
  const isLoading = groupsQuery.isLoading;
  // Treat the user as on-platform until proven otherwise. Default to `true` so
  // the invite-prompt CTA only triggers when we know `exists === false`.
  const isPlatformUser = !activePlatform || (platformStatusQuery.data?.exists ?? true);

  const handleSelectPlatform = (platform: PlatformMetadata | null) => {
    if (platform && platform.status === 'ACTIVE') {
      setSearchParams({ platform: platform.id });
      setInfoMessage(null);
    } else if (platform) {
      setInfoMessage(`Integration with ${platform.fullName} is planned for a future release. Stay tuned!`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      setSearchParams({});
      setInfoMessage(null);
    }
  };

  if (isLoading) {
    return <LoadingSpinner />;
  }

  // Filter groups
  const filteredGroups = groups.filter((g) =>
    g.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    g.description.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const renderIcon = (iconName: string | null, color: string | null, size = 24) => {
    const LucideIcon = (Icons as any)[iconName || 'HelpCircle'] || Icons.HelpCircle;
    return <LucideIcon size={size} style={{ color: color || 'var(--primary)' }} />;
  };

  const handleOpenReasonPopup = (groupId: string) => {
    if (activePopupGroupId === groupId) {
      setActivePopupGroupId(null);
    } else {
      setActivePopupGroupId(groupId);
      setTempReason(customReasons[groupId] || '');
    }
  };

  const handleSaveReason = (groupId: string) => {
    setCustomReasons((prev) => ({
      ...prev,
      [groupId]: tempReason,
    }));
    if (tempReason.trim().length > 0) {
      setSelectedGroups((prev) => ({
        ...prev,
        [groupId]: true,
      }));
    }
    setActivePopupGroupId(null);
  };

  const handleClearReason = (groupId: string) => {
    setCustomReasons((prev) => {
      const copy = { ...prev };
      delete copy[groupId];
      return copy;
    });
    setActivePopupGroupId(null);
  };

  const checkedGroupIds = Object.keys(selectedGroups).filter((id) => selectedGroups[id]);
  const selectableGroups = filteredGroups.filter((g) => g.accessStatus === 'NONE');
  const allSelectableChecked = selectableGroups.length > 0 && selectableGroups.every((g) => selectedGroups[g.id]);

  const handleToggleSelectAll = () => {
    if (!isPlatformUser) {
      setIsInviteModalOpen(true);
      return;
    }
    if (allSelectableChecked) {
      setSelectedGroups((prev) => {
        const copy = { ...prev };
        selectableGroups.forEach((g) => {
          copy[g.id] = false;
        });
        return copy;
      });
    } else {
      setSelectedGroups((prev) => {
        const copy = { ...prev };
        selectableGroups.forEach((g) => {
          copy[g.id] = true;
        });
        return copy;
      });
    }
  };

  const bulkSubmitMutation = useMutation({
    mutationFn: async (
      requestsToSubmit: { groupId: string; justification: string }[]
    ) => {
      return Promise.allSettled(
        requestsToSubmit.map((req) =>
          apiClient.post('/api/access-requests', {
            groupId: req.groupId,
            justification: req.justification,
            duration: selectedDuration,
          })
        )
      );
    },
    onSuccess: (results) => {
      const failures = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      const successes = results.filter((r) => r.status === 'fulfilled');

      if (failures.length > 0) {
        const errorDetails = failures.map((f) => f.reason?.message || 'Unknown error').join(', ');
        setBulkError(`Submitted ${successes.length} request(s) successfully, but ${failures.length} failed: ${errorDetails}`);
      } else {
        setBulkSuccess(`Successfully requested access to ${successes.length} group(s).`);
        setSelectedGroups({});
        setCustomReasons({});
        setGeneralReason('');
      }

      queryClient.invalidateQueries({ queryKey: queryKeys.groups() });
      queryClient.invalidateQueries({ queryKey: queryKeys.myRequests() });
    },
    onError: (err: any) => {
      setBulkError(err.message || 'An error occurred during submission.');
    },
  });

  const isSubmittingBulk = bulkSubmitMutation.isPending;

  const handleBulkSubmit = () => {
    const invalidGroupNames: string[] = [];
    const requestsToSubmit = checkedGroupIds.map((groupId) => {
      const custom = customReasons[groupId]?.trim() || '';
      const justification = custom.length > 0 ? custom : generalReason.trim();
      const groupName = groups.find((g) => g.id === groupId)?.name || 'Unknown Group';

      if (justification.length < 10) {
        invalidGroupNames.push(groupName);
      }

      return { groupId, justification };
    });

    if (invalidGroupNames.length > 0) {
      setBulkError(
        `Justification must be at least 10 characters. Please provide custom reasons or a general reason for: ${invalidGroupNames.join(', ')}`
      );
      return;
    }

    setBulkError(null);
    setBulkSuccess(null);
    bulkSubmitMutation.mutate(requestsToSubmit);
  };

  if (!activePlatform) {
    return (
      <div>
        {/* Page Header */}
        <div className="section-header" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '8px', marginBottom: '32px' }}>
          <h1 style={{ fontSize: '28px', fontFamily: 'Outfit, sans-serif' }}>Access Platforms</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '15px' }}>
            Select an ecosystem platform below to browse groups and manage credentials.
          </p>
        </div>

        {/* Info Banner */}
        {infoMessage && (
          <div style={{
            backgroundColor: 'var(--primary-light)',
            color: 'var(--primary)',
            padding: '16px',
            borderRadius: 'var(--radius-md)',
            fontSize: '14px',
            fontWeight: 600,
            marginBottom: '24px',
            border: '1px solid var(--border-focus)',
            display: 'flex',
            alignItems: 'center',
            gap: '10px'
          }}>
            <Icons.Info size={20} />
            <div style={{ flex: 1 }}>{infoMessage}</div>
            <button 
              type="button" 
              onClick={() => setInfoMessage(null)} 
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
            >
              <Icons.X size={16} />
            </button>
          </div>
        )}

        {/* Platform Grid */}
        <div className="cards-grid">
          {PLATFORMS.map((platform) => {
            const isActive = platform.status === 'ACTIVE';
            const groupCount = platform.id === 'redash' ? groups.length : 0;
            const memberCount = platform.id === 'redash' ? groups.reduce((acc, curr) => acc + curr.memberCount, 0) : 0;

            return (
              <div
                key={platform.id}
                className="group-card"
                onClick={() => handleSelectPlatform(platform)}
                style={{
                  '--card-accent-color': platform.color,
                  cursor: 'pointer',
                  opacity: isActive ? 1 : 0.8,
                  minHeight: '220px',
                  background: isActive ? 'var(--bg-card)' : 'rgba(255, 255, 255, 0.45)',
                  borderColor: isActive ? 'var(--border)' : 'dashed var(--border)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  transition: 'var(--transition)'
                } as React.CSSProperties}
              >
                <div>
                  <div className="group-card-header" style={{ marginBottom: '12px' }}>
                    <div className="group-icon-box" style={{ 
                      background: isActive ? 'var(--primary-light)' : '#f3f4f6', 
                      color: platform.color 
                    }}>
                      {renderIcon(platform.iconName, platform.color, 20)}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <h4 className="group-card-title" style={{ fontSize: '18px' }}>{platform.name}</h4>
                      <span style={{ fontSize: '11px', color: 'var(--text-light)', fontWeight: 600 }}>
                        {platform.fullName}
                      </span>
                    </div>
                  </div>
                  <p className="group-card-desc" style={{ fontSize: '13.5px', marginBottom: '16px', lineHeight: 1.4 }}>
                    {platform.description}
                  </p>
                </div>

                <div className="group-card-footer" style={{ borderTop: '1px solid var(--border)', paddingTop: '12px', marginTop: 'auto' }}>
                  {isActive ? (
                    <>
                      <span className="group-members-count" style={{ fontSize: '12.5px', fontWeight: 600 }}>
                        <Icons.Layers size={14} /> {groupCount} groups • <Icons.Users size={14} /> {memberCount} memberships
                      </span>
                      <span className="badge badge-approved" style={{ fontSize: '10px', padding: '2px 8px' }}>
                        Active
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="group-members-count" style={{ color: 'var(--text-light)', fontSize: '12.5px' }}>
                        <Icons.Lock size={14} /> Integration Pending
                      </span>
                      <span className="badge badge-revoked" style={{ fontSize: '10px', padding: '2px 8px', backgroundColor: 'var(--border)' }}>
                        Coming Soon
                      </span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Back to Platforms Button */}
      <button 
        className="btn btn-outline" 
        onClick={() => handleSelectPlatform(null)} 
        style={{ marginBottom: '24px', padding: '6px 12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
      >
        <Icons.ChevronLeft size={16} /> Back to Platforms
      </button>

      {/* Page Header */}
      <div className="section-header">
        <h1 style={{ fontSize: '28px', fontFamily: 'Outfit, sans-serif' }}>Redash Data Groups</h1>
        
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

      {/* Account Warning Banner */}
      {!isPlatformUser && (
        <div style={{
          backgroundColor: 'var(--status-pending-bg)',
          color: 'var(--status-pending-text)',
          padding: '16px',
          borderRadius: 'var(--radius-md)',
          fontSize: '14.5px',
          fontWeight: 600,
          marginBottom: '24px',
          border: '1px solid var(--status-pending-text)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Icons.AlertTriangle size={20} />
            <span>
              You do not have a Redash account yet. Initialize your account to enable group access requests.
            </span>
          </div>
          <button 
            type="button" 
            className="btn btn-primary" 
            style={{ padding: '6px 14px', fontSize: '12px' }}
            onClick={() => setIsInviteModalOpen(true)}
          >
            Create Redash Account
          </button>
        </div>
      )}

      {/* Success and Error Banners */}
      {bulkSuccess && (
        <div style={{
          backgroundColor: 'var(--status-approved-bg)',
          color: 'var(--status-approved-text)',
          padding: '16px',
          borderRadius: 'var(--radius-md)',
          fontSize: '14px',
          fontWeight: 600,
          marginBottom: '20px',
          border: '1px solid var(--status-approved-text)',
          display: 'flex',
          alignItems: 'center',
          gap: '10px'
        }}>
          <Icons.CheckCircle size={20} />
          <div style={{ flex: 1 }}>{bulkSuccess}</div>
          <button 
            type="button" 
            onClick={() => setBulkSuccess(null)} 
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
          >
            <Icons.X size={16} />
          </button>
        </div>
      )}

      {bulkError && (
        <div style={{
          backgroundColor: 'var(--status-rejected-bg)',
          color: 'var(--status-rejected-text)',
          padding: '16px',
          borderRadius: 'var(--radius-md)',
          fontSize: '14px',
          fontWeight: 600,
          marginBottom: '20px',
          border: '1px solid var(--status-rejected-text)',
          display: 'flex',
          alignItems: 'center',
          gap: '10px'
        }}>
          <Icons.AlertTriangle size={20} />
          <div style={{ flex: 1 }}>{bulkError}</div>
          <button 
            type="button" 
            onClick={() => setBulkError(null)} 
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
          >
            <Icons.X size={16} />
          </button>
        </div>
      )}

      {filteredGroups.length === 0 ? (
        <div className="empty-state">
          <Icons.Search size={44} className="empty-state-icon" />
          <h3 className="empty-state-title">No Groups Found</h3>
          <p className="empty-state-desc">We couldn't find any data groups matching your search term. Try searching for other keywords.</p>
        </div>
      ) : (
        <>
          <div className="table-container">
            <table className="hermes-table">
              <thead>
                <tr>
                  <th style={{ width: '90px', textAlign: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                      <label className="custom-checkbox-container">
                        <input 
                          type="checkbox" 
                          checked={allSelectableChecked} 
                          onChange={handleToggleSelectAll} 
                          disabled={selectableGroups.length === 0}
                        />
                        <span className="checkbox-checkmark"></span>
                      </label>
                    </div>
                  </th>
                  <th>Group Name</th>
                  <th style={{ width: '220px' }}>Active Members</th>
                  <th style={{ width: '180px' }}>Status</th>
                  <th style={{ width: '150px', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredGroups.map((group) => (
                  <tr key={group.id}>
                    <td style={{ textAlign: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                        {group.accessStatus === 'NONE' ? (
                          <>
                            <label className="custom-checkbox-container">
                              <input 
                                type="checkbox"
                                checked={!!selectedGroups[group.id]}
                                onChange={(e) => {
                                  if (!isPlatformUser) {
                                    setIsInviteModalOpen(true);
                                    return;
                                  }
                                  setSelectedGroups(prev => ({
                                    ...prev,
                                    [group.id]: e.target.checked
                                  }));
                                }}
                              />
                              <span className="checkbox-checkmark"></span>
                            </label>
                            
                            <div className="reason-popover-wrapper">
                              <button 
                                type="button"
                                className={`reason-trigger-btn ${customReasons[group.id] ? 'has-reason' : ''}`}
                                onClick={() => {
                                  if (!isPlatformUser) {
                                    setIsInviteModalOpen(true);
                                    return;
                                  }
                                  handleOpenReasonPopup(group.id);
                                }}
                                title={customReasons[group.id] ? "Edit custom justification" : "Add custom justification"}
                              >
                                {customReasons[group.id] ? (
                                  <Icons.FileCheck size={16} />
                                ) : (
                                  <Icons.FileText size={16} />
                                )}
                              </button>
                              
                              {activePopupGroupId === group.id && (
                                <div className="reason-popover">
                                  <div className="reason-popover-title">
                                    Reason for {group.name}
                                  </div>
                                  <textarea
                                    className="reason-popover-textarea"
                                    placeholder="Specific justification for this group (min 10 chars)..."
                                    value={tempReason}
                                    onChange={(e) => setTempReason(e.target.value)}
                                    autoFocus
                                  />
                                  <div className="reason-popover-actions">
                                    <button 
                                      type="button" 
                                      className="btn btn-outline" 
                                      style={{ padding: '4px 8px', fontSize: '11px', borderRadius: '4px', height: 'auto' }}
                                      onClick={() => handleClearReason(group.id)}
                                    >
                                      Clear
                                    </button>
                                    <button 
                                      type="button" 
                                      className="btn btn-primary"
                                      style={{ padding: '4px 8px', fontSize: '11px', borderRadius: '4px', height: 'auto' }}
                                      onClick={() => handleSaveReason(group.id)}
                                      disabled={tempReason.trim().length > 0 && tempReason.trim().length < 10}
                                    >
                                      Save
                                    </button>
                                  </div>
                                  {tempReason.trim().length > 0 && tempReason.trim().length < 10 && (
                                    <span style={{ fontSize: '10px', color: 'var(--status-rejected-text)', marginTop: '2px' }}>
                                      Min 10 characters required.
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          </>
                        ) : (
                          <span style={{ color: 'var(--text-light)', fontSize: '14px' }}>—</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div className="group-icon-box" style={{ width: '32px', height: '32px', borderRadius: '6px', flexShrink: 0 }}>
                          {renderIcon(group.icon, group.color, 18)}
                        </div>
                        <span 
                          style={{ 
                            fontWeight: 700, 
                            color: 'var(--text-main)', 
                            cursor: 'pointer',
                            fontSize: '15px'
                          }}
                          onClick={() => navigate(`/groups/${group.slug}`)}
                        >
                          {group.name}
                        </span>
                        
                        <div className="info-tooltip-container">
                          <Icons.Info size={14} />
                          <div className="info-tooltip">
                            <strong style={{ display: 'block', marginBottom: '4px', fontSize: '13px', color: 'var(--primary-light)' }}>
                              {group.name}
                            </strong>
                            {group.description}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span 
                        className="group-members-count" 
                        onClick={() => navigate(`/groups/${group.slug}`)} 
                        style={{ cursor: 'pointer', textDecoration: 'underline' }}
                      >
                        <Icons.Users size={14} />
                        {group.memberCount} active members
                      </span>
                    </td>
                    <td>
                      {group.accessStatus === 'ACTIVE' && (
                        <span className="badge badge-approved" style={{ gap: '4px' }}>
                          <Icons.CheckCircle size={12} /> Active
                        </span>
                      )}
                      {group.accessStatus === 'PENDING' && (
                        <span className="badge badge-pending" style={{ gap: '4px' }}>
                          <Icons.Clock size={12} /> Pending
                        </span>
                      )}
                      {group.accessStatus === 'NONE' && (
                        <span className="badge badge-revoked" style={{ backgroundColor: 'var(--border)', color: 'var(--text-muted)' }}>
                          No Access
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button 
                        className="btn btn-outline"
                        style={{ padding: '6px 12px', fontSize: '12px' }}
                        onClick={() => navigate(`/groups/${group.slug}`)}
                      >
                        Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Bulk Request Footer Panel */}
          {checkedGroupIds.length > 0 && (
            <div className="bulk-request-panel">
              <div className="bulk-request-header">
                <div className="bulk-request-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Icons.FileText size={18} style={{ color: 'var(--primary)' }} />
                  Request Access for {checkedGroupIds.length} Selected Group(s)
                </div>
                <button 
                  type="button" 
                  className="btn btn-outline" 
                  style={{ padding: '6px 12px', fontSize: '12px' }}
                  onClick={() => {
                    setSelectedGroups({});
                    setCustomReasons({});
                  }}
                >
                  Clear Selection
                </button>
              </div>
              
              <div className="bulk-request-body">
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">
                    General Justification / Reason
                    <span style={{ fontWeight: 'normal', color: 'var(--text-muted)', marginLeft: '6px', fontSize: '12px' }}>
                      (Applies to selected groups without custom reasons)
                    </span>
                  </label>
                  <textarea
                    className="form-textarea"
                    style={{ minHeight: '60px' }}
                    placeholder="Provide a justification of at least 10 characters..."
                    value={generalReason}
                    onChange={(e) => setGeneralReason(e.target.value)}
                    disabled={isSubmittingBulk}
                  />
                </div>
                
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Access Duration</label>
                  <select
                    className="form-select"
                    value={selectedDuration}
                    onChange={(e) => setSelectedDuration(e.target.value)}
                    disabled={isSubmittingBulk}
                  >
                    <option value="PERMANENT">Permanent Access</option>
                    <option value="ONE_DAY">1 Day (Temp Access)</option>
                    <option value="ONE_WEEK">1 Week</option>
                    <option value="ONE_MONTH">1 Month</option>
                    <option value="THREE_MONTHS">3 Months</option>
                  </select>
                </div>
              </div>
              
              <div className="bulk-request-footer">
                <div style={{ marginRight: 'auto', fontSize: '13px', color: 'var(--text-muted)' }}>
                  {(() => {
                    const customCount = Object.keys(customReasons).filter(id => selectedGroups[id] && customReasons[id]?.trim().length >= 10).length;
                    const defaultCount = checkedGroupIds.length - customCount;
                    return (
                      <span>
                        <strong>{customCount}</strong> group(s) with custom reason, <strong>{defaultCount}</strong> using general reason.
                      </span>
                    );
                  })()}
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleBulkSubmit}
                  disabled={
                    isSubmittingBulk || 
                    (checkedGroupIds.some(id => !customReasons[id] || customReasons[id].trim().length < 10) && generalReason.trim().length < 10)
                  }
                >
                  {isSubmittingBulk ? (
                    <>
                      <Icons.Loader size={16} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} /> Submitting...
                    </>
                  ) : (
                    <>
                      <Icons.Send size={16} /> Submit Requests ({checkedGroupIds.length})
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {/* Platform Invite Modal */}
      <PlatformInviteModal
        isOpen={isInviteModalOpen}
        onClose={() => setIsInviteModalOpen(false)}
        platformId="redash"
        platformName="Redash"
        onSuccess={() => {
          if (activePlatform) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.platformStatus(activePlatform),
            });
          }
        }}
      />
    </div>
  );
};

export default Groups;

