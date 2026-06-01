import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  resendRedashInvite,
  syncUserCreationStatusNow,
} from '../services/api/userCreation';
import UserCreationFormModal from '../components/user-creation/UserCreationFormModal';
import * as Icons from 'lucide-react';

/**
 * Per-user landing page for the account-creation lifecycle. Linked from the
 * notification bell (`linkUrl="/account-status"`), the Dashboard banner, and
 * the user's name in the TopBar.
 *
 * Behaviour per status:
 *  - DRAFT          → "Submit account request" CTA opens the form modal.
 *  - PENDING        → "Waiting on admin" passive state.
 *  - APPROVED       → invite call failed last time; show a "Retry setup" button.
 *  - AWAITING_SETUP → direct "Continue to Redash setup" link (uses inviteLink) + Sync now.
 *  - COMPLETED      → success state.
 *  - REJECTED       → show admin's note.
 */
export const AccountStatus: React.FC = () => {
  const { user, refreshUserCreation } = useAuth();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [busy, setBusy] = useState<null | 'retry' | 'sync'>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const uc = user?.userCreation ?? null;

  // Retry only exists for the failure case: status APPROVED with inviteError. It
  // calls the same backend endpoint as a "resend" — `findOrInviteUser` is idempotent.
  const handleRetry = async () => {
    setBusy('retry');
    setMessage(null);
    try {
      await resendRedashInvite();
      await refreshUserCreation();
      setMessage({ kind: 'success', text: 'Setup link generated. Click "Continue to Redash setup" below.' });
    } catch (err: any) {
      setMessage({ kind: 'error', text: err.message || 'Retry failed.' });
    } finally {
      setBusy(null);
    }
  };

  const handleSync = async () => {
    setBusy('sync');
    setMessage(null);
    try {
      await syncUserCreationStatusNow();
      await refreshUserCreation();
      setMessage({ kind: 'success', text: 'Synced with Redash. If your account is set up, this page will reflect it now.' });
    } catch (err: any) {
      setMessage({ kind: 'error', text: err.message || 'Sync failed.' });
    } finally {
      setBusy(null);
    }
  };

  if (!uc) {
    return (
      <div style={{ padding: '40px 0', color: 'var(--text-muted)' }}>
        Loading your account status…
      </div>
    );
  }

  const inviteLinkButton = uc.inviteLink ? (
    <a
      href={uc.inviteLink}
      target="_blank"
      rel="noreferrer noopener"
      className="btn btn-primary"
      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
    >
      <Icons.ExternalLink size={14} />
      Continue to Redash setup
    </a>
  ) : null;

  const renderBody = () => {
    switch (uc.status) {
      case 'DRAFT':
        return (
          <>
            <p>
              You haven't submitted an account request yet. Submit a quick justification and an
              admin will review it.
            </p>
            <button type="button" className="btn btn-primary" onClick={() => setIsFormOpen(true)}>
              <Icons.Send size={14} style={{ marginRight: '6px' }} />
              Submit account request
            </button>
          </>
        );
      case 'PENDING':
        return (
          <>
            <p>
              Your account request is waiting for an admin to review. You can keep browsing groups
              and queue access requests — they'll activate after your account is set up.
            </p>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              Submitted {uc.submittedAt ? new Date(uc.submittedAt).toLocaleString() : '—'}
            </div>
            {uc.justification && (
              <blockquote
                style={{
                  margin: 0,
                  padding: '12px 16px',
                  background: 'var(--bg-app)',
                  borderLeft: '3px solid var(--primary)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '13px',
                  color: 'var(--text-muted)',
                  fontStyle: 'italic',
                }}
              >
                "{uc.justification}"
              </blockquote>
            )}
          </>
        );
      case 'APPROVED':
        // Approved but the Redash invite call failed — offer to retry.
        return (
          <>
            <p>
              An admin approved your account but Hermes hit a snag generating your Redash setup
              link. Click <strong>Retry setup</strong> to try again.
            </p>
            {uc.inviteError && (
              <div
                style={{
                  background: 'var(--status-rejected-bg)',
                  color: 'var(--status-rejected-text)',
                  border: '1px solid var(--status-rejected-text)',
                  padding: '12px',
                  borderRadius: 'var(--radius-md)',
                  fontSize: '13px',
                }}
              >
                <strong>Last error:</strong> {uc.inviteError}
              </div>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleRetry}
              disabled={busy !== null}
            >
              <Icons.RefreshCw size={14} style={{ marginRight: '6px' }} />
              {busy === 'retry' ? 'Retrying…' : 'Retry setup'}
            </button>
          </>
        );
      case 'AWAITING_SETUP':
        return (
          <>
            <p>
              Your account is approved. Click the button below to set your Redash password —
              once that's done, any group access an admin has approved for you will activate
              automatically.
            </p>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              {inviteLinkButton ?? (
                <span
                  style={{
                    fontSize: '13px',
                    color: 'var(--status-rejected-text)',
                  }}
                >
                  No setup link available — please contact your admin.
                </span>
              )}
              <button
                type="button"
                className="btn btn-outline"
                onClick={handleSync}
                disabled={busy !== null}
              >
                <Icons.RefreshCw size={14} style={{ marginRight: '6px' }} />
                {busy === 'sync' ? 'Syncing…' : 'I\'ve finished — sync now'}
              </button>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-light)' }}>
              Link issued: {uc.inviteSentAt ? new Date(uc.inviteSentAt).toLocaleString() : '—'}
            </div>
          </>
        );
      case 'REJECTED':
        return (
          <>
            <p>An admin rejected your account request.</p>
            {uc.rejectionReason && (
              <blockquote
                style={{
                  margin: 0,
                  padding: '12px 16px',
                  background: 'var(--status-rejected-bg)',
                  color: 'var(--status-rejected-text)',
                  borderLeft: '3px solid var(--status-rejected-text)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '13px',
                  fontStyle: 'italic',
                }}
              >
                "{uc.rejectionReason}"
              </blockquote>
            )}
            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              You can address the feedback above and submit a new request, or contact your admin
              if you'd like to appeal.
            </p>
            <button type="button" className="btn btn-primary" onClick={() => setIsFormOpen(true)}>
              <Icons.Send size={14} style={{ marginRight: '6px' }} />
              Request again
            </button>
          </>
        );
      case 'COMPLETED':
        return (
          <>
            <p>You're all set. Your Redash account is active and any approved groups have been provisioned.</p>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              Completed {uc.completedAt ? new Date(uc.completedAt).toLocaleString() : '—'}
            </div>
          </>
        );
      default:
        return <p>Unknown status.</p>;
    }
  };

  return (
    <div style={{ maxWidth: '720px' }}>
      <div className="section-header">
        <h1 style={{ fontSize: '26px', fontFamily: 'Outfit, sans-serif' }}>Account status</h1>
        <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
          {uc.status.replace('_', ' ')}
        </span>
      </div>

      {message && (
        <div
          style={{
            backgroundColor:
              message.kind === 'success' ? 'var(--status-approved-bg)' : 'var(--status-rejected-bg)',
            color:
              message.kind === 'success' ? 'var(--status-approved-text)' : 'var(--status-rejected-text)',
            border: `1px solid ${
              message.kind === 'success' ? 'var(--status-approved-text)' : 'var(--status-rejected-text)'
            }`,
            padding: '12px 16px',
            borderRadius: 'var(--radius-md)',
            fontSize: '13px',
            fontWeight: 600,
            marginBottom: '16px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          {message.kind === 'success' ? (
            <Icons.CheckCircle2 size={16} />
          ) : (
            <Icons.AlertTriangle size={16} />
          )}
          <div style={{ flex: 1 }}>{message.text}</div>
          <button
            type="button"
            onClick={() => setMessage(null)}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}
          >
            <Icons.X size={14} />
          </button>
        </div>
      )}

      <div
        style={{
          background: 'white',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        {renderBody()}
      </div>

      <UserCreationFormModal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        onSubmitted={() => {
          /* refreshUserCreation handled inside the modal */
        }}
      />
    </div>
  );
};

export default AccountStatus;
