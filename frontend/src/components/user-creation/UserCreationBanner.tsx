import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import UserCreationFormModal from './UserCreationFormModal';
import { UserPlus, Clock, Mail, AlertTriangle, CheckCircle2 } from 'lucide-react';

/**
 * Dashboard banner that surfaces the user's current user-creation status.
 * Hidden entirely when status === 'COMPLETED' (or when no userCreation info
 * is available — e.g. the /auth/me call hasn't finished yet).
 */
export const UserCreationBanner: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [isFormOpen, setIsFormOpen] = useState(false);

  const uc = user?.userCreation;
  if (!uc || uc.status === 'COMPLETED') return null;

  let icon: React.ReactNode;
  let title: string;
  let description: string;
  // The banner can render either a Hermes-internal navigation button, or — when
  // the user has a Redash invite link — an external anchor opening Redash in a
  // new tab. We model the CTA as a discriminated union so we can render either.
  let cta: { kind: 'button'; label: string; action: () => void } | { kind: 'link'; label: string; href: string };
  let accent: { bg: string; text: string; border: string };

  switch (uc.status) {
    case 'DRAFT':
      icon = <UserPlus size={24} />;
      title = 'Set up your Redash account';
      description = 'You need an admin-approved Redash account before requested group access can be granted. Submit a quick justification to get started.';
      cta = { kind: 'button', label: 'Request account', action: () => setIsFormOpen(true) };
      accent = { bg: 'hsla(262, 60%, 48%, 0.08)', text: 'var(--primary)', border: 'var(--border-focus)' };
      break;
    case 'PENDING':
      icon = <Clock size={24} />;
      title = 'Account request pending review';
      description = 'An admin is reviewing your account request. You can keep browsing and queue group access requests in the meantime.';
      cta = { kind: 'button', label: 'View status', action: () => navigate('/account-status') };
      accent = { bg: 'hsl(38, 92%, 94%)', text: 'hsl(32, 85%, 33%)', border: 'hsl(32, 85%, 60%)' };
      break;
    case 'APPROVED':
      // APPROVED here means the Redash invite call failed last time. Send the user to /account-status
      // where they can retry.
      icon = <AlertTriangle size={24} />;
      title = 'Account approved — finish setup';
      description = uc.inviteError
        ? `We hit an error generating your setup link: ${uc.inviteError}. Open your account status to retry.`
        : 'Your account was approved. Open your account status to generate your Redash setup link.';
      cta = { kind: 'button', label: 'Open setup', action: () => navigate('/account-status') };
      accent = uc.inviteError
        ? { bg: 'var(--status-rejected-bg)', text: 'var(--status-rejected-text)', border: 'var(--status-rejected-text)' }
        : { bg: 'hsla(262, 60%, 48%, 0.08)', text: 'var(--primary)', border: 'var(--border-focus)' };
      break;
    case 'AWAITING_SETUP':
      icon = <Mail size={24} />;
      title = 'Finish setting up your Redash account';
      description = 'Click below to set your Redash password. Any group access an admin has approved will activate automatically when you\'re done.';
      cta = uc.inviteLink
        ? { kind: 'link', label: 'Continue to Redash setup', href: uc.inviteLink }
        : { kind: 'button', label: 'Open setup', action: () => navigate('/account-status') };
      accent = { bg: 'hsla(262, 60%, 48%, 0.08)', text: 'var(--primary)', border: 'var(--border-focus)' };
      break;
    case 'REJECTED':
      icon = <AlertTriangle size={24} />;
      title = 'Account request rejected';
      description = uc.rejectionReason
        ? `An admin rejected your account request. Reason: "${uc.rejectionReason}". Contact your admin if you'd like to appeal.`
        : 'An admin rejected your account request. Contact your admin if you\'d like to appeal.';
      cta = { kind: 'button', label: 'View details', action: () => navigate('/account-status') };
      accent = { bg: 'var(--status-rejected-bg)', text: 'var(--status-rejected-text)', border: 'var(--status-rejected-text)' };
      break;
    default:
      icon = <CheckCircle2 size={24} />;
      title = 'Account status';
      description = 'View your current Hermes account status.';
      cta = { kind: 'button', label: 'Open', action: () => navigate('/account-status') };
      accent = { bg: 'var(--bg-app)', text: 'var(--text-main)', border: 'var(--border)' };
  }

  return (
    <>
      <div
        style={{
          backgroundColor: accent.bg,
          border: `1px solid ${accent.border}`,
          borderRadius: 'var(--radius-lg)',
          padding: '20px 24px',
          marginBottom: '24px',
          display: 'flex',
          alignItems: 'center',
          gap: '16px',
        }}
      >
        <div style={{ color: accent.text, flexShrink: 0 }}>{icon}</div>
        <div style={{ flex: 1 }}>
          <h3 style={{ fontSize: '16px', fontWeight: 700, color: accent.text, margin: 0, marginBottom: '4px' }}>
            {title}
          </h3>
          <p style={{ fontSize: '14px', color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
            {description}
          </p>
        </div>
        {cta.kind === 'link' ? (
          <a
            href={cta.href}
            target="_blank"
            rel="noreferrer noopener"
            className="btn btn-primary"
            style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            {cta.label}
          </a>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={cta.action}
            style={{ flexShrink: 0 }}
          >
            {cta.label}
          </button>
        )}
      </div>

      <UserCreationFormModal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        onSubmitted={() => {
          // Banner state updates via refreshUserCreation inside the modal.
        }}
      />
    </>
  );
};

export default UserCreationBanner;
