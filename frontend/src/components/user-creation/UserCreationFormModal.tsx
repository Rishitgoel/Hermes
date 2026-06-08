import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { submitUserCreationRequest } from '../../services/api/userCreation';
import { queryKeys } from '../../lib/queryKeys';
import { Send, AlertCircle, Loader } from 'lucide-react';

interface UserCreationFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmitted: () => void;
  /** Platform this account request is for. Defaults to the login-default. */
  platform?: string;
  /** Friendly platform name for copy (e.g. "AWS"). */
  platformName?: string;
}

export const UserCreationFormModal: React.FC<UserCreationFormModalProps> = ({
  isOpen,
  onClose,
  onSubmitted,
  platform = 'redash',
  platformName = 'Redash',
}) => {
  const { user, refreshUserCreation } = useAuth();
  const queryClient = useQueryClient();
  const [justification, setJustification] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const displayName = user?.username.split('_').join(' ') || '';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (justification.trim().length < 10) {
      setError('Justification must be at least 10 characters long.');
      return;
    }
    setIsSubmitting(true);
    try {
      await submitUserCreationRequest(justification.trim(), platform);
      // Refresh both the per-platform status and the /auth/me default-platform row.
      queryClient.invalidateQueries({ queryKey: queryKeys.userCreation(platform) });
      queryClient.invalidateQueries({ queryKey: queryKeys.userCreations() });
      await refreshUserCreation();
      onSubmitted();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to submit request.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '520px' }}>
        <div className="modal-header">
          <h3 className="modal-title">Request a {platformName} Account</h3>
          <button className="modal-close-btn" onClick={onClose} disabled={isSubmitting}>
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <p style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              You don't have a {platformName} account yet. Submit a quick justification so an
              admin can approve creating one for you. While you wait, you can still browse
              groups and queue access requests.
            </p>

            <div
              style={{
                backgroundColor: 'var(--bg-app)',
                padding: '14px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
              }}
            >
              <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Your details (from Hermes session)
              </div>
              <div style={{ fontSize: '14px', fontWeight: 700 }}>
                {displayName}{' '}
                <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>· {user?.email}</span>
              </div>
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" htmlFor="justification">
                Why do you need a {platformName} account?
              </label>
              <textarea
                id="justification"
                className="form-textarea"
                style={{ minHeight: '90px' }}
                placeholder="e.g. I'm joining the Growth team and need to run dashboards for the new attribution model."
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                disabled={isSubmitting}
                maxLength={1000}
                autoFocus
              />
              <div style={{ fontSize: '12px', color: 'var(--text-light)', marginTop: '4px' }}>
                {justification.length} / 1000 characters · minimum 10
              </div>
            </div>

            {error && (
              <div
                style={{
                  backgroundColor: 'var(--status-rejected-bg)',
                  color: 'var(--status-rejected-text)',
                  padding: '12px',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '13px',
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  border: '1px solid var(--status-rejected-text)',
                }}
              >
                <AlertCircle size={16} />
                <span>{error}</span>
              </div>
            )}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting || justification.trim().length < 10}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              {isSubmitting ? (
                <>
                  <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
                  Submitting...
                </>
              ) : (
                <>
                  <Send size={14} />
                  Submit Request
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default UserCreationFormModal;
