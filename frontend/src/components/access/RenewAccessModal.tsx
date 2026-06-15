import React, { useState } from 'react';
import Modal from '../common/Modal';
import apiClient from '../../services/apiClient';

interface RenewAccessModalProps {
  isOpen: boolean;
  onClose: () => void;
  groupId: string;
  groupName: string;
  /** The level the user currently holds (display only — renewal keeps it server-side). */
  currentLevelName?: string | null;
  onSuccess: () => void;
}

/**
 * Request a RENEWAL (extension) of access the user already holds. A renewal keeps the
 * user's current level (resolved server-side from their active grant) and goes through
 * the normal admin-approval flow — so unlike a self-service demotion the expiry only
 * extends after an admin approves it. The user just picks a fresh duration + reason.
 */
export const RenewAccessModal: React.FC<RenewAccessModalProps> = ({
  isOpen,
  onClose,
  groupId,
  groupName,
  currentLevelName,
  onSuccess,
}) => {
  const [justification, setJustification] = useState('');
  const [duration, setDuration] = useState('THREE_MONTHS');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const resetForm = () => {
    setJustification('');
    setDuration('THREE_MONTHS');
    setErrorMsg(null);
    setSubmitted(false);
  };

  const handleClose = () => {
    if (isSubmitting) return;
    resetForm();
    onClose();
  };

  const handleDone = () => {
    onSuccess();
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (justification.trim().length < 10) {
      setErrorMsg('Please write a justification of at least 10 characters.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      await apiClient.post('/api/access-requests/renew', {
        groupId,
        justification,
        duration,
      });
      setSubmitted(true);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to submit renewal request');
    } finally {
      setIsSubmitting(false);
    }
  };

  const footerActions = submitted ? (
    <button type="button" className="btn btn-primary" onClick={handleDone}>
      Done
    </button>
  ) : (
    <>
      <button type="button" className="btn btn-outline" onClick={handleClose} disabled={isSubmitting}>
        Cancel
      </button>
      <button type="submit" form="renew-access-form" className="btn btn-primary" disabled={isSubmitting}>
        {isSubmitting ? 'Submitting...' : 'Request Extension'}
      </button>
    </>
  );

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={`Extend Access — ${groupName}`} footer={footerActions}>
      {submitted ? (
        <div
          style={{
            backgroundColor: 'var(--status-approved-bg)',
            color: 'var(--status-approved-text)',
            padding: '14px',
            borderRadius: 'var(--radius-sm)',
            fontSize: '14px',
            fontWeight: 600,
          }}
        >
          Your extension request for {groupName} was submitted. Your current access stays
          active until an admin approves it — once approved, your expiry is extended.
        </div>
      ) : (
        <form id="renew-access-form" onSubmit={handleSubmit}>
          {errorMsg && (
            <div
              style={{
                backgroundColor: 'var(--status-rejected-bg)',
                color: 'var(--status-rejected-text)',
                padding: '12px',
                borderRadius: 'var(--radius-sm)',
                fontSize: '13px',
                fontWeight: 600,
                marginBottom: '16px',
              }}
            >
              {errorMsg}
            </div>
          )}

          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '14px' }}>
            You're requesting more time on{' '}
            <strong style={{ color: 'var(--text-main)' }}>{groupName}</strong>
            {currentLevelName ? (
              <>
                {' '}at the{' '}
                <strong style={{ color: 'var(--text-main)' }}>{currentLevelName}</strong> level
              </>
            ) : null}
            . An admin reviews it like a normal request; your access keeps working in the meantime.
          </div>

          <div className="form-group">
            <label className="form-label">Justification / Reason</label>
            <textarea
              className="form-textarea"
              placeholder="Explain why you still need access (e.g. the campaign was extended into next quarter)..."
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
            <label className="form-label">New Access Duration</label>
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
            <span style={{ fontSize: '11px', color: 'var(--text-light)' }}>
              The new window starts when an admin approves the extension.
            </span>
          </div>
        </form>
      )}
    </Modal>
  );
};

export default RenewAccessModal;
