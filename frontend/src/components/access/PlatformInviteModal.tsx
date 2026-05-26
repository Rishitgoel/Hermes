import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import apiClient from '../../services/apiClient';
import { UserPlus, Mail, AlertCircle, CheckCircle, Loader } from 'lucide-react';

interface PlatformInviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  platformId: string;
  platformName: string;
  onSuccess: () => void;
}

export const PlatformInviteModal: React.FC<PlatformInviteModalProps> = ({
  isOpen,
  onClose,
  platformId,
  platformName,
  onSuccess,
}) => {
  const { user } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      await apiClient.post(`/api/user-access/platform-user/${platformId}`);
      setSuccess(true);
      setTimeout(() => {
        onSuccess();
        onClose();
      }, 2000);
    } catch (err: any) {
      console.error(`Failed to invite user to platform ${platformId}:`, err);
      setError(err.response?.data?.message || err.message || 'An error occurred while sending the invitation.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Human-readable username representation
  const displayName = user?.username.split('_').join(' ') || '';

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '480px' }}>
        <div className="modal-header">
          <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <UserPlus size={20} style={{ color: 'var(--primary)' }} />
            Initialize {platformName} Account
          </h3>
          <button className="modal-close-btn" onClick={onClose} disabled={isSubmitting}>
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {success ? (
              <div style={{
                textAlign: 'center',
                padding: '24px 8px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '12px'
              }}>
                <CheckCircle size={48} style={{ color: 'var(--status-approved-text)' }} />
                <h4 style={{ color: 'var(--status-approved-text)', fontSize: '18px' }}>Invitation Sent!</h4>
                <p style={{ fontSize: '14px', color: 'var(--text-muted)' }}>
                  A Redash invitation was sent to your email. You can now request access to Redash groups!
                </p>
              </div>
            ) : (
              <>
                <p style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  You don't have a registered account on the <strong>{platformName}</strong> platform yet.
                  To request permissions for any data groups, you must first create your platform user account.
                </p>

                <div style={{
                  backgroundColor: 'var(--bg-app)',
                  padding: '16px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px'
                }}>
                  <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Account Details (from Atlas profile)
                  </div>
                  <div style={{ fontSize: '14px', fontWeight: 700 }}>
                    Name: <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{displayName}</span>
                  </div>
                  <div style={{ fontSize: '14px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    Email: <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{user?.email}</span>
                  </div>
                </div>

                <div style={{ 
                  display: 'flex', 
                  alignItems: 'flex-start', 
                  gap: '8px', 
                  backgroundColor: 'hsla(262, 60%, 48%, 0.05)', 
                  border: '1px solid var(--border-focus)',
                  borderRadius: 'var(--radius-md)',
                  padding: '12px'
                }}>
                  <Mail size={16} style={{ color: 'var(--primary)', marginTop: '2px', flexShrink: 0 }} />
                  <span style={{ fontSize: '12.5px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                    By clicking <strong>Send Invitation</strong>, an automated setup email will be sent to your inbox.
                    Your account will be instantly recognized by Atlas.
                  </span>
                </div>

                {error && (
                  <div style={{
                    backgroundColor: 'var(--status-rejected-bg)',
                    color: 'var(--status-rejected-text)',
                    padding: '12px',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '13px',
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    border: '1px solid var(--status-rejected-text)'
                  }}>
                    <AlertCircle size={16} />
                    <span>{error}</span>
                  </div>
                )}
              </>
            )}
          </div>

          {!success && (
            <div className="modal-footer">
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
                className="btn btn-primary"
                disabled={isSubmitting}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                {isSubmitting ? (
                  <>
                    <Loader size={14} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} />
                    Sending Invite...
                  </>
                ) : (
                  <>
                    <UserPlus size={14} />
                    Send Invitation
                  </>
                )}
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
};

export default PlatformInviteModal;
