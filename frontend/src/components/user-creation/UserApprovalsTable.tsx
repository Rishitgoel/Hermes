import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listPendingUserCreations, reviewUserCreation, PendingUserCreationRequest } from '../../services/api/userCreation';
import { queryKeys } from '../../lib/queryKeys';
import { useToast } from '../../contexts/ToastContext';
import * as Icons from 'lucide-react';

/**
 * Admin-only table of pending user-creation requests. Rendered above the existing
 * group-access approvals table on the Pending Approvals page. Per-row Approve /
 * Reject (no bulk select — the volume is low and the action is high-stakes).
 */
export const UserApprovalsTable: React.FC = () => {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [activeNotes, setActiveNotes] = useState<Record<string, string>>({});
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);

  const { data: rows = [], isLoading } = useQuery<PendingUserCreationRequest[]>({
    queryKey: queryKeys.pendingUserCreations(),
    queryFn: listPendingUserCreations,
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: 'APPROVED' | 'REJECTED'; note?: string }) =>
      reviewUserCreation(id, status, note),
    onSuccess: (_, vars) => {
      const verb = vars.status === 'APPROVED' ? 'approved' : 'rejected';
      toast.success(`User-creation request ${verb}.`);
      setActiveNotes((prev) => {
        const copy = { ...prev };
        delete copy[vars.id];
        return copy;
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.pendingUserCreations() });
      // Approving a user-creation request unblocks any of their pending group requests.
      queryClient.invalidateQueries({ queryKey: queryKeys.pendingRequests() });
    },
    onError: (err: any) => {
      toast.error(err.message || 'Review failed.');
    },
  });

  const isSubmitting = reviewMutation.isPending;

  if (isLoading) {
    return (
      <div style={{ padding: '20px 0', color: 'var(--text-muted)' }}>Loading user approvals…</div>
    );
  }

  const formatDate = (iso: string | null) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getInitials = (name: string) =>
    name
      .split('_')
      .join(' ')
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .substring(0, 2);

  return (
    <div style={{ marginBottom: '32px' }}>
      <div className="section-header" style={{ marginBottom: '12px' }}>
        <h2 style={{ fontSize: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Icons.UserPlus size={20} style={{ color: 'var(--primary)' }} />
          User Approvals
        </h2>
        <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 700 }}>
          {rows.length} Pending
        </span>
      </div>

      <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '12px' }}>
        Approve these <strong>before</strong> any group access request from the same user.
      </p>

      {rows.length === 0 ? (
        <div className="empty-state" style={{ padding: '24px' }}>
          <Icons.UserCheck size={32} className="empty-state-icon" />
          <h4 className="empty-state-title" style={{ fontSize: '15px' }}>No pending users</h4>
          <p className="empty-state-desc" style={{ fontSize: '13px' }}>
            Every account request has been reviewed.
          </p>
        </div>
      ) : (
        <div className="table-container">
          <table className="hermes-table">
            <thead>
              <tr>
                <th>Requester</th>
                <th style={{ width: '110px' }}>Platform</th>
                <th>Justification</th>
                <th style={{ width: '180px' }}>Submitted</th>
                <th style={{ width: '300px', textAlign: 'right' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div
                        className="user-avatar"
                        style={{
                          width: '32px',
                          height: '32px',
                          fontSize: '11px',
                          flexShrink: 0,
                          background: 'linear-gradient(135deg, var(--primary), var(--secondary))',
                        }}
                      >
                        {getInitials(row.userName)}
                      </div>
                      <div>
                        <div style={{ fontWeight: 700, color: 'var(--text-main)', fontSize: '14px' }}>
                          {row.userName.replace('_', ' ')}
                        </div>
                        <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{row.userEmail}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="badge badge-admin badge-sm">
                      {row.platform}
                    </span>
                  </td>
                  <td>
                    <span style={{ color: 'var(--text-muted)', fontSize: '13px', lineHeight: 1.4 }}>
                      {row.justification || <em>(no justification)</em>}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-light)', fontSize: '13px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Icons.Calendar size={12} />
                      {formatDate(row.submittedAt || row.createdAt)}
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', alignItems: 'center', position: 'relative' }}>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        onClick={() => {
                          setOpenNoteId((cur) => (cur === row.id ? null : row.id));
                        }}
                      >
                        <Icons.FileText size={12} />
                        {activeNotes[row.id] ? 'Edit note' : 'Note'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline btn-danger-outline btn-sm"
                        onClick={() => reviewMutation.mutate({ id: row.id, status: 'REJECTED', note: activeNotes[row.id] })}
                        disabled={isSubmitting}
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => reviewMutation.mutate({ id: row.id, status: 'APPROVED', note: activeNotes[row.id] })}
                        disabled={isSubmitting}
                      >
                        Approve
                      </button>

                      {openNoteId === row.id && (
                        <div
                          className="reason-popover"
                          style={{ position: 'absolute', right: 0, top: '36px', zIndex: 10 }}
                        >
                          <div className="reason-popover-title">
                            Optional note for {row.userName.replace('_', ' ')}
                          </div>
                          <textarea
                            className="reason-popover-textarea"
                            placeholder="e.g. Confirmed with manager"
                            value={activeNotes[row.id] || ''}
                            onChange={(e) =>
                              setActiveNotes((prev) => ({ ...prev, [row.id]: e.target.value }))
                            }
                          />
                          <div className="reason-popover-actions">
                            <button
                              type="button"
                              className="btn btn-outline"
                              style={{ padding: '4px 8px', fontSize: '11px', borderRadius: '4px', height: 'auto' }}
                              onClick={() => {
                                setActiveNotes((prev) => {
                                  const copy = { ...prev };
                                  delete copy[row.id];
                                  return copy;
                                });
                                setOpenNoteId(null);
                              }}
                            >
                              Clear
                            </button>
                            <button
                              type="button"
                              className="btn btn-primary"
                              style={{ padding: '4px 8px', fontSize: '11px', borderRadius: '4px', height: 'auto' }}
                              onClick={() => setOpenNoteId(null)}
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      )}
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

export default UserApprovalsTable;
