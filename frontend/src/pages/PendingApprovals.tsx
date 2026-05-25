import React, { useState, useEffect } from 'react';
import apiClient from '../services/apiClient';
import LoadingSpinner from '../components/common/LoadingSpinner';
import { CheckSquare, XCircle, CheckCircle2, Calendar } from 'lucide-react';

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
}

export const PendingApprovals: React.FC = () => {
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const fetchPending = async () => {
    try {
      const res = await apiClient.get('/api/access-requests/pending');
      setRequests(res.data);
    } catch (err) {
      console.error('Failed to fetch pending requests:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchPending();
  }, []);

  const handleReview = async (requestId: string, status: 'APPROVED' | 'REJECTED') => {
    const note = notes[requestId] || '';
    
    setActioningId(requestId);
    setSuccessMessage(null);

    try {
      await apiClient.put(`/api/access-requests/${requestId}/review`, {
        status,
        note,
      });

      setSuccessMessage(`Request successfully ${status.toLowerCase()}ed.`);
      
      // Clean note input
      setNotes((prev) => {
        const copy = { ...prev };
        delete copy[requestId];
        return copy;
      });

      // Reload
      fetchPending();
    } catch (err: any) {
      alert(`Failed to complete review: ${err.message}`);
    } finally {
      setActioningId(null);
      // Auto clear success message
      setTimeout(() => setSuccessMessage(null), 4000);
    }
  };

  const handleNoteChange = (requestId: string, value: string) => {
    setNotes((prev) => ({ ...prev, [requestId]: value }));
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
      <div className="section-header">
        <h1 style={{ fontSize: '28px', fontFamily: 'Outfit, sans-serif' }}>Pending Access Approvals</h1>
        <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 700 }}>
          {requests.length} Requests Pending
        </span>
      </div>

      {/* Success banner */}
      {successMessage && (
        <div style={{
          backgroundColor: 'var(--status-approved-bg)',
          color: 'var(--status-approved-text)',
          padding: '16px',
          borderRadius: 'var(--radius-md)',
          marginBottom: '24px',
          fontWeight: 700,
          fontSize: '14px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          boxShadow: 'var(--shadow-sm)',
          animation: 'fadeIn 0.2s ease-out'
        }}>
          <CheckCircle2 size={18} />
          {successMessage}
        </div>
      )}

      {requests.length === 0 ? (
        <div className="empty-state">
          <CheckSquare size={44} className="empty-state-icon" />
          <h3 className="empty-state-title">Approval Queue Empty</h3>
          <p className="empty-state-desc">There are currently no access requests waiting to be reviewed. Good job!</p>
        </div>
      ) : (
        <div className="approval-card-list">
          {requests.map((req) => (
            <div key={req.id} className="approval-card">
              <div className="approval-card-header">
                <div className="approval-card-user-info">
                  <div className="approval-card-avatar">
                    {getInitials(req.requesterName)}
                  </div>
                  <div className="approval-card-req-meta">
                    <span className="approval-card-title">{req.requesterName.replace('_', ' ')}</span>
                    <span className="approval-card-email">{req.requesterEmail}</span>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                  <span style={{ 
                    fontWeight: 800, 
                    fontSize: '13px', 
                    color: req.group.color || 'var(--primary)',
                    backgroundColor: 'var(--primary-light)',
                    padding: '4px 10px',
                    borderRadius: 'var(--radius-sm)'
                  }}>
                    {req.group.name} Group
                  </span>
                  <div style={{ fontSize: '11px', color: 'var(--text-light)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Calendar size={12} />
                    {formatDate(req.createdAt)}
                  </div>
                </div>
              </div>

              {/* Justification details */}
              <div className="approval-card-body">
                <div style={{ fontWeight: 800, fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>
                  Justification
                </div>
                <div>"{req.justification}"</div>
                <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
                  Duration: <strong style={{ textTransform: 'lowercase' }}>{req.duration.replace('_', ' ')}</strong>
                </div>
              </div>

              {/* Admin note + actions */}
              <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end' }}>
                <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                  <label className="form-label">Review Note / Reason (Optional)</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="Enter approval note or reason for rejection..."
                    value={notes[req.id] || ''}
                    onChange={(e) => handleNoteChange(req.id, e.target.value)}
                    disabled={actioningId === req.id}
                  />
                </div>
                
                <div className="approval-card-actions">
                  <button
                    className="btn btn-outline"
                    style={{ borderColor: 'var(--status-rejected-text)', color: 'var(--status-rejected-text)', gap: '6px' }}
                    onClick={() => handleReview(req.id, 'REJECTED')}
                    disabled={actioningId === req.id}
                  >
                    <XCircle size={16} /> Reject
                  </button>
                  <button
                    className="btn btn-primary"
                    style={{ gap: '6px' }}
                    onClick={() => handleReview(req.id, 'APPROVED')}
                    disabled={actioningId === req.id}
                  >
                    <CheckCircle2 size={16} /> Approve & Provision
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default PendingApprovals;
