import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '../services/apiClient';
import LoadingSpinner from '../components/common/LoadingSpinner';
import StatusBadge from '../components/common/StatusBadge';
import ExpiryBadge from '../components/common/ExpiryBadge';
import ReasonModal from '../components/common/ReasonModal';
import { FileText } from 'lucide-react';
import { queryKeys } from '../lib/queryKeys';
import AccountStatusPanel from '../components/user-creation/AccountStatusPanel';
import SectionHeader from '../components/common/SectionHeader';
import { useToast } from '../contexts/ToastContext';

interface RequestData {
  id: string;
  groupId: string;
  justification: string;
  duration: string;
  status: string;
  reviewerName: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  provisionError?: string | null;
  group: {
    name: string;
    color: string | null;
  };
  level: {
    name: string;
    permission: string | null;
  } | null;
}

/**
 * Statuses a requester can still pull back. Mirrors the server's rule exactly (see
 * accessWorkflowService.withdrawRequest): both are pre-provisioning, and both are what the
 * one-open-request-per-group index blocks on — so withdrawing is also how a user unblocks
 * themselves to request that group again.
 */
const WITHDRAWABLE = ['PENDING', 'WAITING_FOR_SETUP'];

export const MyRequests: React.FC = () => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [withdrawing, setWithdrawing] = useState<RequestData | null>(null);

  const { data: requests = [], isLoading } = useQuery<RequestData[]>({
    queryKey: queryKeys.myRequests(),
    queryFn: () => apiClient.get('/api/access-requests/my').then((r) => r.data),
  });

  const withdrawMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiClient.post(`/api/access-requests/${id}/withdraw`, reason ? { reason } : {}),
    onSuccess: () => {
      toast.success('Request withdrawn. You can request this group again whenever you need it.');
      setWithdrawing(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.myRequests() });
      // The group's request button keys off whether an open request exists, so both the
      // list and any open detail page need refreshing too.
      queryClient.invalidateQueries({ queryKey: queryKeys.groups() });
      queryClient.invalidateQueries({ queryKey: queryKeys.myAccess() });
    },
    onError: (err: any) => toast.error(err?.message || 'Failed to withdraw request.'),
  });

  const formatDate = (isoString: string) => {
    return new Date(isoString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div>
      <AccountStatusPanel />

      <SectionHeader title="My Access Requests" meta={`${requests.length} Requests Total`} />

      {isLoading ? (
        <LoadingSpinner />
      ) : requests.length === 0 ? (
        <div className="empty-state">
          <FileText size={44} className="empty-state-icon" />
          <h3 className="empty-state-title">No Requests Found</h3>
          <p className="empty-state-desc">You haven't submitted any access requests yet. Go to the Groups page to browse data groups.</p>
        </div>
      ) : (
        <div className="table-container">
          <table className="hermes-table">
            <thead>
              <tr>
                <th>Group</th>
                <th>Justification</th>
                <th>Duration</th>
                <th>Submitted</th>
                <th>Status</th>
                <th>Reviewer Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {requests.map((req) => (
                <tr key={req.id}>
                  <td>
                    <span style={{
                      fontWeight: 700,
                      color: req.group.color || 'var(--primary)',
                      borderLeft: `3px solid ${req.group.color || 'var(--primary)'}`,
                      paddingLeft: '8px'
                    }}>
                      {req.group.name}
                    </span>
                    {req.level && (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, paddingLeft: '11px', marginTop: '2px' }}>
                        {req.level.name}{req.level.permission ? ` · ${req.level.permission}` : ''}
                      </div>
                    )}
                  </td>
                  <td style={{ maxWidth: '280px', fontSize: '13px' }} title={req.justification}>
                    {req.justification}
                  </td>
                  <td style={{ textTransform: 'lowercase', fontWeight: 600 }}>
                    {req.duration.replace('_', ' ')}
                  </td>
                  <td style={{ fontSize: '13px', whiteSpace: 'nowrap' }}>
                    {formatDate(req.createdAt)}
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
                      <StatusBadge status={req.status} error={req.provisionError} />
                      {req.status === 'PROVISIONED' && req.expiresAt && <ExpiryBadge expiresAt={req.expiresAt} />}
                    </div>
                  </td>
                  <td style={{ fontSize: '13px', maxWidth: '200px' }}>
                    {req.reviewerName ? (
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '11px', color: 'var(--text-muted)' }}>
                          Reviewed by {req.reviewerName}
                        </div>
                        {req.reviewNote && <div style={{ fontStyle: 'italic' }}>"{req.reviewNote}"</div>}
                      </div>
                    ) : req.status === 'WITHDRAWN' ? (
                      // A withdrawal has no reviewer — the note is the requester's own reason,
                      // so label it as such instead of falling through to the "—" placeholder.
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '11px', color: 'var(--text-muted)' }}>
                          Withdrawn by you
                        </div>
                        {req.reviewNote && <div style={{ fontStyle: 'italic' }}>"{req.reviewNote}"</div>}
                      </div>
                    ) : (
                      <span style={{ color: 'var(--text-light)', fontStyle: 'italic' }}>—</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {WITHDRAWABLE.includes(req.status) && (
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        onClick={() => setWithdrawing(req)}
                        disabled={withdrawMutation.isPending}
                      >
                        Withdraw
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ReasonModal
        isOpen={!!withdrawing}
        title="Withdraw request"
        message={
          <>
            Withdraw your request for <strong>{withdrawing?.group.name}</strong>? It will be removed
            from the approval queue and you can submit a new request for this group at any time.
          </>
        }
        placeholder="Why are you withdrawing this? (optional)"
        confirmLabel="Withdraw request"
        loading={withdrawMutation.isPending}
        onConfirm={(reason) => withdrawing && withdrawMutation.mutate({ id: withdrawing.id, reason })}
        onClose={() => setWithdrawing(null)}
      />
    </div>
  );
};

export default MyRequests;
