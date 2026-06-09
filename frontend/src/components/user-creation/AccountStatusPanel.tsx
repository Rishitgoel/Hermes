import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth, type UserCreationInfo } from '../../contexts/AuthContext';
import {
  getMyUserCreations,
  resendInvite,
  syncUserCreationStatusNow,
} from '../../services/api/userCreation';
import { queryKeys } from '../../lib/queryKeys';
import UserCreationFormModal from './UserCreationFormModal';
import * as Icons from 'lucide-react';

const PLATFORM_LABELS: Record<string, string> = { redash: 'Redash', aws: 'AWS', jira: 'Jira' };
const platformLabel = (p: string): string =>
  PLATFORM_LABELS[p] ?? p.charAt(0).toUpperCase() + p.slice(1);

/**
 * Account-creation lifecycle panel — now PER PLATFORM. Renders one status card for
 * each platform the user has an account request on (from /me/all). A user can hold
 * separate accounts (e.g. Redash + AWS), each with its own lifecycle + actions.
 */
export const AccountStatusPanel: React.FC = () => {
  const { data: rows = [], isLoading } = useQuery<UserCreationInfo[]>({
    queryKey: queryKeys.userCreations(),
    queryFn: getMyUserCreations,
  });

  // Nothing to show until /me/all resolves (or the user has no requests at all).
  if (isLoading || rows.length === 0) return null;

  return (
    <div style={{ marginBottom: '24px' }}>
      <div className="section-header">
        <h3 className="section-title">Account status</h3>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {rows.map((uc) => (
          <PlatformAccountCard key={uc.id} uc={uc} />
        ))}
      </div>
    </div>
  );
};

const PlatformAccountCard: React.FC<{ uc: UserCreationInfo }> = ({ uc }) => {
  const { refreshUserCreation } = useAuth();
  const queryClient = useQueryClient();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [busy, setBusy] = useState<null | 'retry' | 'sync'>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const label = platformLabel(uc.platform);

  const refresh = async () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.userCreations() });
    queryClient.invalidateQueries({ queryKey: queryKeys.userCreation(uc.platform) });
    await refreshUserCreation();
  };

  const handleRetry = async () => {
    setBusy('retry');
    setMessage(null);
    try {
      await resendInvite(uc.platform);
      await refresh();
      setMessage({ kind: 'success', text: `Setup link regenerated. Use "Continue to ${label} setup" below.` });
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
      await syncUserCreationStatusNow(uc.platform);
      await refresh();
      setMessage({ kind: 'success', text: `Synced with ${label}. If your account is set up, this will reflect it now.` });
    } catch (err: any) {
      setMessage({ kind: 'error', text: err.message || 'Sync failed.' });
    } finally {
      setBusy(null);
    }
  };

  // COMPLETED → compact one-line confirmation.
  if (uc.status === 'COMPLETED') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          backgroundColor: 'var(--status-approved-bg)',
          color: 'var(--status-approved-text)',
          border: '1px solid var(--status-approved-text)',
          padding: '12px 16px',
          borderRadius: 'var(--radius-md)',
          fontSize: '13px',
          fontWeight: 600,
        }}
      >
        <Icons.CheckCircle2 size={16} />
        <span>
          {uc.platform === 'aws' ? (
            <>Your AWS account is set up. First sign-in? Check your email to set your password.</>
          ) : (
            <>
              Your {label} account is active
              {uc.completedAt ? ` · set up ${new Date(uc.completedAt).toLocaleDateString()}` : ''}.
            </>
          )}
        </span>
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
      Continue to {label} setup
    </a>
  ) : null;

  const renderBody = () => {
    switch (uc.status) {
      case 'DRAFT':
        return (
          <>
            <p>
              You haven't submitted a {label} account request yet. Submit a quick justification and
              an admin will review it.
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
              Your {label} account request is waiting for an admin to review. You can keep browsing
              groups and queue access requests — they'll activate after your account is set up.
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
        return (
          <>
            <p>
              An admin approved your {label} account but Hermes hit a snag finalizing setup.
              {uc.platform === 'redash' ? (
                <> Click <strong>Retry setup</strong> to try again.</>
              ) : (
                <> Please contact an admin to retry.</>
              )}
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
            {uc.platform === 'redash' && (
              <button type="button" className="btn btn-primary" onClick={handleRetry} disabled={busy !== null}>
                <Icons.RefreshCw size={14} style={{ marginRight: '6px' }} />
                {busy === 'retry' ? 'Retrying…' : 'Retry setup'}
              </button>
            )}
          </>
        );
      case 'AWAITING_SETUP':
        return (
          <>
            <p>
              Your {label} account is approved.{' '}
              {uc.inviteLink
                ? `Click the button below to finish setup — once done, any approved group access will activate automatically.`
                : `Check your email for ${label} sign-in instructions — your approved group access will activate automatically.`}
            </p>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              {inviteLinkButton}
              <button type="button" className="btn btn-outline" onClick={handleSync} disabled={busy !== null}>
                <Icons.RefreshCw size={14} style={{ marginRight: '6px' }} />
                {busy === 'sync' ? 'Syncing…' : "I've finished — sync now"}
              </button>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-light)' }}>
              {uc.inviteSentAt ? `Issued ${new Date(uc.inviteSentAt).toLocaleString()}` : ''}
            </div>
          </>
        );
      case 'REJECTED':
        return (
          <>
            <p>An admin rejected your {label} account request.</p>
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
            <button type="button" className="btn btn-primary" onClick={() => setIsFormOpen(true)}>
              <Icons.Send size={14} style={{ marginRight: '6px' }} />
              Request again
            </button>
          </>
        );
      default:
        return <p>Unknown status.</p>;
    }
  };

  return (
    <div>
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
            padding: '10px 14px',
            borderRadius: 'var(--radius-md)',
            fontSize: '13px',
            fontWeight: 600,
            marginBottom: '8px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          {message.kind === 'success' ? <Icons.CheckCircle2 size={16} /> : <Icons.AlertTriangle size={16} />}
          <div style={{ flex: 1 }}>{message.text}</div>
          <button type="button" onClick={() => setMessage(null)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>
            <Icons.X size={14} />
          </button>
        </div>
      )}

      <div
        style={{
          background: 'white',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 700, fontSize: '15px' }}>{label} account</span>
          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            {uc.status.replace('_', ' ')}
          </span>
        </div>
        {renderBody()}
      </div>

      <UserCreationFormModal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        platform={uc.platform}
        platformName={label}
        onSubmitted={() => {
          /* invalidation handled inside the modal */
        }}
      />
    </div>
  );
};

export default AccountStatusPanel;
