import React, { useState } from 'react';
import Modal from '../common/Modal';
import apiClient from '../../services/apiClient';

interface AccessRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  groupId: string;
  groupName: string;
  onSuccess: () => void;
}

export const AccessRequestModal: React.FC<AccessRequestModalProps> = ({
  isOpen,
  onClose,
  groupId,
  groupName,
  onSuccess,
}) => {
  const [justification, setJustification] = useState('');
  const [duration, setDuration] = useState('PERMANENT');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (justification.trim().length < 10) {
      setErrorMsg('Please write a justification of at least 10 characters.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      await apiClient.post('/api/access-requests', {
        groupId,
        justification,
        duration,
      });
      setJustification('');
      setDuration('PERMANENT');
      onSuccess();
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to submit request');
    } finally {
      setIsSubmitting(false);
    }
  };

  const footerActions = (
    <>
      <button 
        type="button" 
        className="btn btn-outline" 
        onClick={onClose} 
        disabled={isSubmitting}
      >
        Cancel
      </button>
      <button 
        type="submit" 
        form="access-request-form" 
        className="btn btn-primary" 
        disabled={isSubmitting}
      >
        {isSubmitting ? 'Submitting...' : 'Submit Request'}
      </button>
    </>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Request Access to ${groupName}`}
      footer={footerActions}
    >
      <form id="access-request-form" onSubmit={handleSubmit}>
        {errorMsg && (
          <div style={{
            backgroundColor: 'var(--status-rejected-bg)',
            color: 'var(--status-rejected-text)',
            padding: '12px',
            borderRadius: 'var(--radius-sm)',
            fontSize: '13px',
            fontWeight: 600,
            marginBottom: '16px'
          }}>
            {errorMsg}
          </div>
        )}

        <div className="form-group">
          <label className="form-label">Justification / Reason</label>
          <textarea
            className="form-textarea"
            placeholder="Explain why you need access to this group (e.g. Q3 Growth analysis campaign)..."
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            disabled={isSubmitting}
            required
          />
          <span style={{ fontSize: '11px', color: 'var(--text-light)' }}>
            Minimum 10 characters. Keep it brief and clear.
          </span>
        </div>

        <div className="form-group">
          <label className="form-label">Access Duration</label>
          <select
            className="form-select"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            disabled={isSubmitting}
          >
            <option value="PERMANENT">Permanent Access</option>
            <option value="ONE_DAY">1 Day (Temp Access)</option>
            <option value="ONE_WEEK">1 Week</option>
            <option value="ONE_MONTH">1 Month</option>
            <option value="THREE_MONTHS">3 Months</option>
          </select>
        </div>
      </form>
    </Modal>
  );
};

export default AccessRequestModal;
