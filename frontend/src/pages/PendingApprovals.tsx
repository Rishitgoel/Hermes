import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import apiClient from '../services/apiClient';
import LoadingSpinner from '../components/common/LoadingSpinner';
import UserApprovalsTable from '../components/user-creation/UserApprovalsTable';
import { listPendingUserCreations } from '../services/api/userCreation';
import { useAuth } from '../contexts/AuthContext';
import * as Icons from 'lucide-react';
import { queryKeys } from '../lib/queryKeys';
import SectionHeader from '../components/common/SectionHeader';

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
  // Account-creation review is per-platform: super admins (all platforms) and
  // platform admins (their platform(s)) can approve. Pure group admins cannot.
  const canApproveAccounts =
    !!user?.adminScopes?.superAdmin || (user?.adminScopes?.platforms?.length ?? 0) > 0;

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
  // Only account reviewers (super + platform admins) can hit the pending endpoint; for a
  // platform admin the rows come back scoped to their platform(s). Skip for group admins.
  const { data: pendingUserCreations = [] } = useQuery({
    queryKey: queryKeys.pendingUserCreations(),
    queryFn: listPendingUserCreations,
    enabled: canApproveAccounts,
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
    // One HTTP call instead of N parallel PUTs (P2-2). The backend reviews each item
    // independently (so a per-item failure — auth, user-not-approved, provision error
    // — never aborts the rest) and returns per-item reviewed/failed.
    mutationFn: async (status: 'APPROVED' | 'REJECTED') => {
      const items = checkedRequestIds.map((requestId) => {
        const custom = customNotes[requestId]?.trim() || '';
        const note = custom.length > 0 ? custom : generalNote.trim();
        return { requestId, status, ...(note ? { note } : {}) };
      });
      const res = await apiClient.put('/api/access-requests/bulk/review', { items });
      return {
        result: res.data as {
          reviewed: { requestId: string; status: string }[];
          failed: { requestId: string; error: string; errorCode?: string }[];
        },
        status,
      };
    },
    onSuccess: ({ result, status }) => {
      const verb = status === 'APPROVED' ? 'approved' : 'rejected';
      if (result.failed.length > 0) {
        const hasUserNotApproved = result.failed.some((f) => f.errorCode === 'USER_NOT_APPROVED');
        const prefix = hasUserNotApproved
          ? "Some requests can't be approved yet — approve the requester's account in the User Approvals section first. "
          : '';
        const details = result.failed.map((f) => f.error).join(', ');
        setBulkError(
          `${prefix}Reviewed ${result.reviewed.length} request(s); ${result.failed.length} failed: ${details}`
        );
      } else {
        setBulkSuccess(`Successfully ${verb} ${result.reviewed.length} request(s).`);
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
      setBulkError(err.message || 'An error occurred during submission.');
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
      {/* Account-creation approvals — super admins (all platforms) + platform admins
          (their platform's rows). Group admins can't approve account creation. */}
      {canApproveAccounts && <UserApprovalsTable />}

      <SectionHeader
        title="Pending Access Approvals"
        icon={<Icons.CheckSquare size={18} />}
        meta={`${requests.length} Requests Pending`}
      />

      {/* Success and Error Banners — bulk results stay inline (per-item detail), not toasts */}
      {bulkSuccess && (
        <div className="banner banner-success">
          <Icons.CheckCircle2 size={20} />
          <div className="banner-body">{bulkSuccess}</div>
          <button type="button" className="banner-close" onClick={() => setBulkSuccess(null)}>
            <Icons.X size={16} />
          </button>
        </div>
      )}

      {bulkError && (
        <div className="banner banner-error">
          <Icons.AlertTriangle size={20} />
          <div className="banner-body">{bulkError}</div>
          <button type="button" className="banner-close" onClick={() => setBulkError(null)}>
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
                                  style={{ padding: '4px 8px', fontSize: '12px', borderRadius: '4px', height: 'auto' }}
                                  onClick={() => handleClearNote(req.id)}
                                >
                                  Clear
                                </button>
                                <button 
                                  type="button" 
                                  className="btn btn-primary"
                                  style={{ padding: '4px 8px', fontSize: '12px', borderRadius: '4px', height: 'auto' }}
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
                            className="badge badge-pending badge-sm"
                            style={{ whiteSpace: 'nowrap' }}
                            title="Approve this user in User Approvals first"
                          >
                            Approve user first
                          </span>
                        )}

                        <div className="info-tooltip-container">
                          <Icons.Info size={14} />
                          <div className="info-tooltip">
                            <strong style={{ display: 'block', marginBottom: '4px', fontSize: '13px', color: 'var(--primary)' }}>
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
                  className="btn btn-outline btn-sm"
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
                    className="btn btn-outline btn-danger-outline"
                    style={{ gap: '6px' }}
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

