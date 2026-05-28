import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import UserCreationFormModal from '../user-creation/UserCreationFormModal';
import { UserPlus, Mail, Clock, AlertTriangle } from 'lucide-react';

interface PlatformInviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  platformId: string;
  platformName: string;
  onSuccess: () => void;
}

/**
 * Shown when a user tries to act on a platform they don't have access to yet.
 *
 * Previously this modal fired an instant Redash invitation. With the new
 * admin-approval gate, instead it routes the user to the right next step
 * depending on their UserCreationRequest status:
 *  - DRAFT          → open the submission form
 *  - PENDING        → "waiting on admin" passive message + link to /account-status
 *  - AWAITING_SETUP → "check your email" + link to /account-status
 *  - REJECTED       → message + link to /account-status
 *
 * The actual Redash invite is now triggered server-side when an admin approves
 * the user-creation request, not from this modal.
 */
export const PlatformInviteModal: React.FC<PlatformInviteModalProps> = ({
  isOpen,
  onClose,
  platformName,
  onSuccess,
}) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [showForm, setShowForm] = useState(false);

  if (!isOpen) return null;

  const uc = user?.userCreation ?? null;
  const displayName = user?.username.split('_').join(' ') || '';

  const goToStatus = () => {
    onClose();
    navigate('/account-status');
  };

  let icon: React.ReactNode = <UserPlus size={20} style={{ color: 'var(--primary)' }} />;
  let title = `Set up your ${platformName} account`;
  let body: React.ReactNode = null;
  let primary: { label: string; action: () => void } | null = null;

  if (!uc || uc.status === 'DRAFT') {
    body = (
      <>
        <p style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          You don't have a {platformName} account yet. Submit a quick request and an admin will
          approve creating one for you. You can keep using Hermes while you wait — any group
          access you request now will activate as soon as your account is set up.
        </p>
        <div
          style={{
            backgroundColor: 'var(--bg-app)',
            padding: '14px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)',
          }}
        >
          <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>
            Your details
          </div>
          <div style={{ fontSize: '14px', fontWeight: 700 }}>
            {displayName}{' '}
            <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>· {user?.email}</span>
          </div>
        </div>
      </>
    );
    primary = { label: 'Request account', action: () => setShowForm(true) };
  } else if (uc.status === 'PENDING') {
    icon = <Clock size={20} style={{ color: 'hsl(32, 85%, 33%)' }} />;
    title = 'Account request pending';
    body = (
      <p style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        An admin is reviewing your account request. You'll be able to act on {platformName}{' '}
        groups once it's approved and you've completed setup. You can queue group access
        requests in the meantime.
      </p>
    );
    primary = { label: 'View status', action: goToStatus };
  } else if (uc.status === 'AWAITING_SETUP') {
    icon = <Mail size={20} style={{ color: 'var(--primary)' }} />;
    title = `Finish setting up ${platformName}`;
    body = (
      <p style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Your account was approved. Click the link below to set your Redash password — once
        you finish, any approved group memberships will activate automatically.
      </p>
    );
    // Prefer opening Redash directly from here when we have the link.
    if (uc.inviteLink) {
      primary = {
        label: 'Continue to Redash setup',
        action: () => {
          window.open(uc.inviteLink!, '_blank', 'noopener,noreferrer');
        },
      };
    } else {
      primary = { label: 'Open account setup', action: goToStatus };
    }
  } else if (uc.status === 'APPROVED') {
    icon = <Mail size={20} style={{ color: 'var(--primary)' }} />;
    title = `Finish setting up ${platformName}`;
    body = (
      <p style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Your account was approved but Hermes hit an error generating your setup link.
        Open account setup to retry.
      </p>
    );
    primary = { label: 'Open account setup', action: goToStatus };
  } else if (uc.status === 'REJECTED') {
    icon = <AlertTriangle size={20} style={{ color: 'var(--status-rejected-text)' }} />;
    title = 'Account request rejected';
    body = (
      <p style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Your account request was declined. Contact an admin if you'd like to appeal.
      </p>
    );
    primary = { label: 'View details', action: goToStatus };
  } else {
    // COMPLETED — shouldn't normally land here because callers check status first.
    body = (
      <p style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Your {platformName} account is already set up. Try refreshing the page.
      </p>
    );
  }

  return (
    <>
      <div className="modal-overlay">
        <div className="modal-content" style={{ maxWidth: '480px' }}>
          <div className="modal-header">
            <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {icon}
              {title}
            </h3>
            <button className="modal-close-btn" onClick={onClose}>
              &times;
            </button>
          </div>

          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {body}
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose}>
              Close
            </button>
            {primary && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={primary.action}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                {primary.label}
              </button>
            )}
          </div>
        </div>
      </div>

      <UserCreationFormModal
        isOpen={showForm}
        onClose={() => setShowForm(false)}
        onSubmitted={() => {
          // After submit, let the caller know so it can refresh & close.
          onSuccess();
        }}
      />
    </>
  );
};

export default PlatformInviteModal;
