import React, { useState } from 'react';
import Modal from '../common/Modal';
import apiClient from '../../services/apiClient';

export interface GroupLevelOption {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  permission?: string | null;
  rank?: number;
}

interface AccessRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  groupId: string;
  groupName: string;
  /** Permission-levels (subgroups) of this group. When non-empty, the user must pick one. */
  levels?: GroupLevelOption[];
  onSuccess: () => void;
}

export const AccessRequestModal: React.FC<AccessRequestModalProps> = ({
  isOpen,
  onClose,
  groupId,
  groupName,
  levels = [],
  onSuccess,
}) => {
  const [justification, setJustification] = useState('');
  const [duration, setDuration] = useState('PERMANENT');
  const [levelId, setLevelId] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const hasLevels = levels.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (hasLevels && !levelId) {
      setErrorMsg('Please select a level for this group.');
      return;
    }
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
        ...(hasLevels ? { levelId } : {}),
      });
      setJustification('');
      setDuration('PERMANENT');
      setLevelId('');
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

        {hasLevels && (
          <div className="form-group">
            <label className="form-label">Level</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {levels.map((lvl) => {
                const selected = levelId === lvl.id;
                return (
                  <label
                    key={lvl.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '10px',
                      padding: '10px 12px',
                      border: `1px solid ${selected ? 'var(--primary)' : 'var(--border)'}`,
                      borderRadius: 'var(--radius-sm)',
                      backgroundColor: selected ? 'var(--primary-subtle, rgba(0,0,0,0.03))' : 'transparent',
                      cursor: isSubmitting ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <input
                      type="radio"
                      name="level"
                      value={lvl.id}
                      checked={selected}
                      onChange={() => setLevelId(lvl.id)}
                      disabled={isSubmitting}
                      style={{ marginTop: '3px' }}
                    />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ fontWeight: 600, fontSize: '13px' }}>
                        {lvl.name}
                        {lvl.permission && (
                          <span
                            style={{
                              marginLeft: '8px',
                              fontSize: '11px',
                              fontWeight: 600,
                              color: 'var(--text-muted)',
                              border: '1px solid var(--border)',
                              borderRadius: 'var(--radius-sm)',
                              padding: '1px 6px',
                            }}
                          >
                            {lvl.permission}
                          </span>
                        )}
                      </span>
                      {lvl.description && (
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{lvl.description}</span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
            <span style={{ fontSize: '11px', color: 'var(--text-light)' }}>
              Each level grants a different permission tier for this group.
            </span>
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
