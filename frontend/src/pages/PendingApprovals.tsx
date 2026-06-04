import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import apiClient from '../services/apiClient';
import LoadingSpinner from '../components/common/LoadingSpinner';
import UserApprovalsTable from '../components/user-creation/UserApprovalsTable';
import { listPendingUserCreations } from '../services/api/userCreation';
import { useAuth } from '../contexts/AuthContext';
import * as Icons from 'lucide-react';
import { queryKeys } from '../lib/queryKeys';

interface PendingRequest {
  id: string;
  groupId: string;
  requesterId: string;
  requesterName: string;
  requesterEmail: string;
  justification: string;
  duration: string;
  status: string;
  createdAt: string;
  group: {
    name: string;
    color: string | null;
  };
  level: {
    name: string;
    permission: string | null;
  } | null;
}

export const PendingApprovals: React.FC = () => {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isSuperAdmin = !!user?.roles?.includes('hermes_super_admin');

  const { data: requests = [], isLoading } = useQuery<PendingRequest[]>({
    queryKey: queryKeys.pendingRequests(),
    queryFn: () => apiClient.get('/api/access-requests/pending').then((r) => r.data),
    // Requests are created in another session (the requester's), so the only way
    // this admin view learns about a new one is by polling. Without these, the
    // page piggybacks on the Sidebar's slow 60s badge poll, so a freshly
    // submitted request can stay invisible here for up to a minute. Poll faster
    // while the queue is open, and always refetch on navigation (overriding the
    // 30s global staleTime) so "I just submitted it" requests show immediately.
    refetchInterval: 15000,
    refetchOnMount: 'always',
  });

  // Set of userIds whose group requests are blocked (no approved user-creation row yet).
  // We treat anyone with a row in PENDING as "blocked"; admin must approve user-creation first.
  // Only super-admins can hit /api/user-creation-requests/pending — skip the query for group admins.
  const { data: pendingUserCreations = [] } = useQuery({
    queryKey: queryKeys.pendingUserCreations(),
    queryFn: listPendingUserCreations,
    enabled: isSuperAdmin,
  });
  const blockedUserIds = new Set(pendingUserCreations.map((r) => r.userId));

  // Selection & custom notes state
  const [selectedRequests, setSelectedRequests] = useState<Record<string, boolean>>({});
  const [customNotes, setCustomNotes] = useState<Record<string, string>>({});
  const [generalNote, setGeneralNote] = useState('');
  const [activePopupId, setActivePopupId] = useState<string | null>(null);

  const [tempNote, setTempNote] = useState('');
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkSuccess, setBulkSuccess] = useState<string | null>(null);

  const handleOpenNotePopup = (requestId: string) => {
    if (activePopupId === requestId) {
      setActivePopupId(null);
    } else {
      setActivePopupId(requestId);
      setTempNote(customNotes[requestId] || '');
    }
  };

  const handleSaveNote = (requestId: string) => {
    setCustomNotes((prev) => ({
      ...prev,
      [requestId]: tempNote,
    }));
    // Automatically select the request when adding a custom note
    if (tempNote.trim().length > 0) {
      setSelectedRequests((prev) => ({
        ...prev,
        [requestId]: true,
      }));
    }
    setActivePopupId(null);
  };

  const handleClearNote = (requestId: string) => {
    setCustomNotes((prev) => {
      const copy = { ...prev };
      delete copy[requestId];
      return copy;
    });
    setActivePopupId(null);
  };

  const checkedRequestIds = Object.keys(selectedRequests).filter((id) => selectedRequests[id]);
  const selectableRequests = requests.filter((r) => !blockedUserIds.has(r.requesterId));
  const allChecked =
    selectableRequests.length > 0 && selectableRequests.every((r) => selectedRequests[r.id]);

  const handleToggleSelectAll = () => {
    if (allChecked) {
      setSelectedRequests({});
    } else {
      const copy: Record<string, boolean> = {};
      selectableRequests.forEach((r) => {
        copy[r.id] = true;
      });
      setSelectedRequests(copy);
    }
  };

  const bulkReviewMutation = useMutation({
    mutationFn: async (status: 'APPROVED' | 'REJECTED') => {
      const results = await Promise.allSettled(
        checkedRequestIds.map((requestId) => {
          const custom = customNotes[requestId]?.trim() || '';
          const note = custom.length > 0 ? custom : generalNote.trim();
          return apiClient.put(`/api/access-requests/${requestId}/review`, {
            status,
            note,
          });
        })
      );
      return { results, status };
    },
    onSuccess: ({ results, status }) => {
      const failures = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      const successes = results.filter((r) => r.status === 'fulfilled');

      if (failures.length > 0) {
        const errorDetails = failures.map((f) => f.reason?.message || 'Unknown error').join(', ');
        setBulkError(`Successfully reviewed ${successes.length} request(s), but ${failures.length} failed: ${errorDetails}`);
      } else {
        setBulkSuccess(`Successfully ${status.toLowerCase()}ed ${successes.length} request(s).`);
        setSelectedRequests({});
        setCustomNotes({});
        setGeneralNote('');
      }

      // Any successful review changes pending list + may grant access, so
      // invalidate the related query trees.
      queryClient.invalidateQueries({ queryKey: queryKeys.pendingRequests() });
      queryClient.invalidateQueries({ queryKey: queryKeys.groups() });
      queryClient.invalidateQueries({ queryKey: queryKeys.myAccess() });
    },
    onError: (err: any) => {
      // Surface USER_NOT_APPROVED specially so the admin knows to approve the user first.
      if (err?.errorCode === 'USER_NOT_APPROVED') {
        setBulkError('One or more requests can\'t be approved yet — approve the requester\'s account in the User Approvals section first.');
      } else {
        setBulkError(err.message || 'An error occurred during submission.');
      }
    },
  });

  const isSubmitting = bulkReviewMutation.isPending;

  const handleBulkReview = (status: 'APPROVED' | 'REJECTED') => {
    setBulkError(null);
    setBulkSuccess(null);
    bulkReviewMutation.mutate(status);
  };

  if (isLoading) {
    return <LoadingSpinner />;
  }

  const getInitials = (name: string) => {
    return name
      .split('_')
      .join(' ')
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .substring(0, 2);
  };

  const formatDate = (isoString: string) => {
    return new Date(isoString).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div>
      {/* User-creation approvals — super-admins only. Group admins can't approve org-wide
          identity creation. */}
      {isSuperAdmin && <UserApprovalsTable />}

      <div className="section-header">
        <h1 style={{ fontSize: '28px', fontFamily: 'Outfit, sans-serif' }}>Pending Access Approvals</h1>
        <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 700 }}>
          {requests.length} Requests Pending
        </span>
      </div>

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
          <Icons.CheckCircle2 size={20} />
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

      {requests.length === 0 ? (
        <div className="empty-state">
          <Icons.CheckSquare size={44} className="empty-state-icon" />
          <h3 className="empty-state-title">Approval Queue Empty</h3>
          <p className="empty-state-desc">There are currently no access requests waiting to be reviewed. Good job!</p>
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
                          checked={allChecked} 
                          onChange={handleToggleSelectAll} 
                          disabled={requests.length === 0}
                        />
                        <span className="checkbox-checkmark"></span>
                      </label>
                    </div>
                  </th>
                  <th>Requester</th>
                  <th>Requested Group</th>
                  <th style={{ width: '220px' }}>Requested Duration</th>
                  <th style={{ width: '200px' }}>Date</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((req) => {
                  const isBlocked = blockedUserIds.has(req.requesterId);
                  return (
                  <tr key={req.id} style={isBlocked ? { opacity: 0.65 } : undefined}>
                    <td style={{ textAlign: 'center' }}>
                      <div
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}
                        title={isBlocked ? 'Approve this user in User Approvals first' : undefined}
                      >
                        <label className="custom-checkbox-container">
                          <input
                            type="checkbox"
                            checked={!!selectedRequests[req.id]}
                            disabled={isBlocked}
                            onChange={(e) => {
                              if (isBlocked) return;
                              setSelectedRequests(prev => ({
                                ...prev,
                                [req.id]: e.target.checked
                              }));
                            }}
                          />
                          <span className="checkbox-checkmark"></span>
                        </label>
                        
                        <div className="reason-popover-wrapper">
                          <button 
                            type="button"
                            className={`reason-trigger-btn ${customNotes[req.id] ? 'has-reason' : ''}`}
                            onClick={() => handleOpenNotePopup(req.id)}
                            title={customNotes[req.id] ? "Edit custom review note" : "Add custom review note"}
                          >
                            {customNotes[req.id] ? (
                              <Icons.FileCheck size={16} />
                            ) : (
                              <Icons.FileText size={16} />
                            )}
                          </button>
                          
                          {activePopupId === req.id && (
                            <div className="reason-popover">
                              <div className="reason-popover-title">
                                Note for {req.requesterName.replace('_', ' ')}
                              </div>
                              <textarea
                                className="reason-popover-textarea"
                                placeholder="Add an optional note or reason for review..."
                                value={tempNote}
                                onChange={(e) => setTempNote(e.target.value)}
                                autoFocus
                              />
                              <div className="reason-popover-actions">
                                <button 
                                  type="button" 
                                  className="btn btn-outline" 
                                  style={{ padding: '4px 8px', fontSize: '11px', borderRadius: '4px', height: 'auto' }}
                                  onClick={() => handleClearNote(req.id)}
                                >
                                  Clear
                                </button>
                                <button 
                                  type="button" 
                                  className="btn btn-primary"
                                  style={{ padding: '4px 8px', fontSize: '11px', borderRadius: '4px', height: 'auto' }}
                                  onClick={() => handleSaveNote(req.id)}
                                >
                                  Save
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div 
                          className="user-avatar" 
                          style={{ 
                            width: '32px', 
                            height: '32px', 
                            fontSize: '11px', 
                            flexShrink: 0,
                            background: 'linear-gradient(135deg, var(--primary), var(--secondary))' 
                          }}
                        >
                          {getInitials(req.requesterName)}
                        </div>
                        <span style={{ fontWeight: 700, color: 'var(--text-main)', fontSize: '15px' }}>
                          {req.requesterName.replace('_', ' ')}
                        </span>

                        {isBlocked && (
                          <span
                            style={{
                              fontSize: '11px',
                              fontWeight: 700,
                              padding: '2px 8px',
                              borderRadius: '999px',
                              background: 'hsl(38, 92%, 94%)',
                              color: 'hsl(32, 85%, 33%)',
                              border: '1px solid hsl(32, 85%, 60%)',
                              whiteSpace: 'nowrap',
                            }}
                            title="Approve this user in User Approvals first"
                          >
                            Approve user first
                          </span>
                        )}

                        <div className="info-tooltip-container">
                          <Icons.Info size={14} />
                          <div className="info-tooltip">
                            <strong style={{ display: 'block', marginBottom: '4px', fontSize: '13px', color: 'var(--primary-light)' }}>
                              Request Details
                            </strong>
                            <div style={{ marginBottom: '6px' }}><strong>Email:</strong> {req.requesterEmail}</div>
                            <div style={{ marginBottom: '6px' }}><strong>Justification:</strong> "{req.justification}"</div>
                            <div><strong>Requested At:</strong> {formatDate(req.createdAt)}</div>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <span style={{
                          fontWeight: 800,
                          fontSize: '13px',
                          color: req.group.color || 'var(--primary)',
                          backgroundColor: 'var(--primary-light)',
                          padding: '4px 10px',
                          borderRadius: 'var(--radius-sm)'
                        }}>
                          {req.group.name}
                        </span>
                        {req.level && (
                          <span style={{
                            fontWeight: 700,
                            fontSize: '12px',
                            color: 'var(--text-muted)',
                            border: '1px solid var(--border)',
                            padding: '3px 8px',
                            borderRadius: 'var(--radius-sm)'
                          }}>
                            {req.level.name}
                            {req.level.permission ? ` · ${req.level.permission}` : ''}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span style={{ textTransform: 'capitalize', fontWeight: 600, color: 'var(--text-muted)' }}>
                        {req.duration.replace('_', ' ').toLowerCase()}
                      </span>
                    </td>
                    <td style={{ color: 'var(--text-light)', fontSize: '13px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Icons.Calendar size={12} />
                        {formatDate(req.createdAt)}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Bulk Request Footer Panel */}
          {checkedRequestIds.length > 0 && (
            <div className="bulk-request-panel" style={{ marginTop: '32px' }}>
              <div className="bulk-request-header">
                <div className="bulk-request-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Icons.CheckSquare size={18} style={{ color: 'var(--primary)' }} />
                  Review {checkedRequestIds.length} Selected Request(s)
                </div>
                <button 
                  type="button" 
                  className="btn btn-outline" 
                  style={{ padding: '6px 12px', fontSize: '12px' }}
                  onClick={() => {
                    setSelectedRequests({});
                    setCustomNotes({});
                  }}
                >
                  Clear Selection
                </button>
              </div>
              
              <div className="bulk-request-body" style={{ gridTemplateColumns: '1fr' }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">
                    General Review Note / Reason
                    <span style={{ fontWeight: 'normal', color: 'var(--text-muted)', marginLeft: '6px', fontSize: '12px' }}>
                      (Applies to selected reviews without custom notes)
                    </span>
                  </label>
                  <textarea
                    className="form-textarea"
                    style={{ minHeight: '60px' }}
                    placeholder="Provide an optional note/reason for review (e.g. Approved per manager request, Rejected due to insufficient explanation)..."
                    value={generalNote}
                    onChange={(e) => setGeneralNote(e.target.value)}
                    disabled={isSubmitting}
                  />
                </div>
              </div>
              
              <div className="bulk-request-footer">
                <div style={{ marginRight: 'auto', fontSize: '13px', color: 'var(--text-muted)' }}>
                  {(() => {
                    const customCount = Object.keys(customNotes).filter(id => selectedRequests[id] && customNotes[id]?.trim().length > 0).length;
                    const defaultCount = checkedRequestIds.length - customCount;
                    return (
                      <span>
                        <strong>{customCount}</strong> request(s) with custom note, <strong>{defaultCount}</strong> using general note.
                      </span>
                    );
                  })()}
                </div>
                
                <div style={{ display: 'flex', gap: '12px' }}>
                  <button
                    type="button"
                    className="btn btn-outline"
                    style={{ borderColor: 'var(--status-rejected-text)', color: 'var(--status-rejected-text)', gap: '6px' }}
                    onClick={() => handleBulkReview('REJECTED')}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? (
                      <Icons.Loader size={16} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} />
                    ) : (
                      <Icons.XCircle size={16} />
                    )}
                    Reject Selected ({checkedRequestIds.length})
                  </button>
                  
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ gap: '6px' }}
                    onClick={() => handleBulkReview('APPROVED')}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? (
                      <Icons.Loader size={16} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} />
                    ) : (
                      <Icons.CheckCircle2 size={16} />
                    )}
                    Approve Selected ({checkedRequestIds.length})
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default PendingApprovals;

