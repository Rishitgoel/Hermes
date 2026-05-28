import React from 'react';
import { useQuery } from '@tanstack/react-query';
import apiClient from '../services/apiClient';
import LoadingSpinner from '../components/common/LoadingSpinner';
import StatusBadge from '../components/common/StatusBadge';
import { FileText } from 'lucide-react';
import { queryKeys } from '../lib/queryKeys';

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
  group: {
    name: string;
    color: string | null;
  };
}

export const MyRequests: React.FC = () => {
  const { data: requests = [], isLoading } = useQuery<RequestData[]>({
    queryKey: queryKeys.myRequests(),
    queryFn: () => apiClient.get('/api/access-requests/my').then((r) => r.data),
  });

  if (isLoading) {
    return <LoadingSpinner />;
  }

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
      <div className="section-header">
        <h1 style={{ fontSize: '28px', fontFamily: 'Outfit, sans-serif' }}>My Access Requests</h1>
        <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 700 }}>
          {requests.length} Requests Total
        </span>
      </div>

      {requests.length === 0 ? (
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
                    <StatusBadge status={req.status} />
                  </td>
                  <td style={{ fontSize: '13px', maxWidth: '200px' }}>
                    {req.reviewerName ? (
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '11px', color: 'var(--text-muted)' }}>
                          Reviewed by {req.reviewerName}
                        </div>
                        {req.reviewNote && <div style={{ fontStyle: 'italic' }}>"{req.reviewNote}"</div>}
                      </div>
                    ) : (
                      <span style={{ color: 'var(--text-light)', fontStyle: 'italic' }}>—</span>
                    )}
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

export default MyRequests;
