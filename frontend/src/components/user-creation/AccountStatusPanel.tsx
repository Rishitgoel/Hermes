import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import apiClient from '../../services/apiClient';
import { useAuth, type UserCreationInfo, type UserCreationStatus } from '../../contexts/AuthContext';
import {
  getMyUserCreations,
  resendInvite,
  syncUserCreationStatusNow,
} from '../../services/api/userCreation';
import { fetchPlatforms, type LivePlatform } from '../../services/api/platforms';
import { queryKeys } from '../../lib/queryKeys';
import { PLATFORMS, platformDisplayName } from '../../lib/platforms';
import UserCreationFormModal from './UserCreationFormModal';
import * as Icons from 'lucide-react';

/**
 * "Your platform accounts" hub — one compact row per LIVE (registered) platform,
 * merged with the user's account-creation rows from /me/all. Every platform shows
 * even if the user has never requested it, so account creation can be kicked off
 * right here. Each row carries a single context-aware action (Request / Finish
 * setup / Retry / Open platform), a lifecycle stepper while in-flight, and a tie-in
 * to the group access that account unlocks.
 */

/** Slim shape of GET /api/user-access/me — we only need the platform per grant. */
interface MyAccessRow {
  group?: { platform?: string | null };
}
/** Slim shape of GET /api/access-requests/my — platform + status for the tie-in. */
interface MyRequestRow {
  status: string;
  group?: { platform?: string | null };
}

interface PlatformEntry {
  platform: string;
  live: LivePlatform | null;
  uc: UserCreationInfo | null;
  /** Active group grants the user holds on this platform. */
  activeGroups: number;
  /** Group requests queued behind this platform's account setup (WAITING_FOR_SETUP). */
  queuedRequests: number;
}

const STEP_LABELS = ['Request', 'Review', 'Set up', 'Active'] as const;

/** Which lifecycle step a status sits at, or null when no stepper applies. */
function stepState(status: UserCreationStatus | null): { current: number; errored: boolean } | null {
  switch (status) {
    case 'PENDING':
      return { current: 1, errored: false }; // at Review
    case 'APPROVED':
      return { current: 2, errored: true }; // approved, but the invite snagged at Set up
    case 'AWAITING_SETUP':
      return { current: 2, errored: false }; // at Set up
    default:
      return null; // DRAFT / null (no account) / REJECTED / COMPLETED
  }
}

/** Compact relative time, e.g. "2d ago". */
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days > 0) return `${days}d ago`;
  const hrs = Math.floor(ms / 3_600_000);
  if (hrs > 0) return `${hrs}h ago`;
  const mins = Math.floor(ms / 60_000);
  if (mins > 0) return `${mins}m ago`;
  return 'just now';
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString();

export const AccountStatusPanel: React.FC = () => {
  const { data: rows = [], isLoading } = useQuery<UserCreationInfo[]>({
    queryKey: queryKeys.userCreations(),
    queryFn: getMyUserCreations,
  });
  const { data: livePlatforms = [] } = useQuery<LivePlatform[]>({
    queryKey: queryKeys.platforms(),
    queryFn: fetchPlatforms,
  });
  const { data: accesses = [] } = useQuery<MyAccessRow[]>({
    queryKey: queryKeys.myAccess(),
    queryFn: () => apiClient.get('/api/user-access/me').then((r) => r.data),
  });
  const { data: myRequests = [] } = useQuery<MyRequestRow[]>({
    queryKey: queryKeys.myRequests(),
    queryFn: () => apiClient.get('/api/access-requests/my').then((r) => r.data),
  });

  const entries = useMemo<PlatformEntry[]>(() => {
    const ucByPlatform = new Map(rows.map((r) => [r.platform, r]));
    const liveByKey = new Map(livePlatforms.map((lp) => [lp.key, lp]));

    // Show every live platform first (in registry order), then append any existing
    // rows whose platform is no longer registered — so we never hide an account the
    // user already holds, even if its adapter was de-registered.
    const keys: string[] = livePlatforms.map((lp) => lp.key);
    rows.forEach((r) => {
      if (!liveByKey.has(r.platform)) keys.push(r.platform);
    });

    return keys.map((platform) => ({
      platform,
      live: liveByKey.get(platform) ?? null,
      uc: ucByPlatform.get(platform) ?? null,
      activeGroups: accesses.filter((a) => a.group?.platform === platform).length,
      queuedRequests: myRequests.filter(
        (q) => q.group?.platform === platform && q.status === 'WAITING_FOR_SETUP',
      ).length,
    }));
  }, [rows, livePlatforms, accesses, myRequests]);

  if (isLoading) return null;
  if (entries.length === 0) return null;

  const activeCount = entries.filter((e) => e.uc?.status === 'COMPLETED').length;
  const inSetupCount = entries.filter(
    (e) => e.uc?.status === 'AWAITING_SETUP' || e.uc?.status === 'APPROVED',
  ).length;

  const summary = [`${entries.length} platform${entries.length === 1 ? '' : 's'}`];
  if (activeCount > 0) summary.push(`${activeCount} active`);
  if (inSetupCount > 0) summary.push(`${inSetupCount} in setup`);

  return (
    <div style={{ marginBottom: '24px' }}>
      <div className="section-header">
        <h3 className="section-title">Your platform accounts</h3>
        <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 700 }}>
          {summary.join(' · ')}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {entries.map((entry) => (
          <PlatformAccountRow key={entry.platform} entry={entry} />
        ))}
      </div>
    </div>
  );
};

const btnSm: React.CSSProperties = {
  whiteSpace: 'nowrap',
};

const LifecycleStepper: React.FC<{ current: number; errored: boolean }> = ({ current, errored }) => {
  const currentText = errored ? 'var(--status-rejected-text)' : 'var(--status-pending-text)';
  const currentBg = errored ? 'var(--status-rejected-bg)' : 'var(--status-pending-bg)';
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      {STEP_LABELS.map((labelText, i) => {
        const done = i < current;
        const isCurrent = i === current;
        const dotBg = done ? 'var(--primary)' : isCurrent ? currentBg : 'var(--bg-app)';
        const dotBorder = done ? 'var(--primary)' : isCurrent ? currentText : 'var(--border)';
        const labelColor = isCurrent ? currentText : done ? 'var(--text-muted)' : 'var(--text-light)';
        return (
          <React.Fragment key={labelText}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '62px', flex: '0 0 auto' }}>
              <div
                style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  background: dotBg,
                  border: `1.5px solid ${dotBorder}`,
                  color: 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxSizing: 'border-box',
                }}
              >
                {done && <Icons.Check size={11} />}
              </div>
              <span style={{ fontSize: '11px', color: labelColor, marginTop: '4px', fontWeight: isCurrent ? 700 : 600 }}>
                {labelText}
              </span>
            </div>
            {i < STEP_LABELS.length - 1 && (
              <div style={{ flex: 1, height: '2px', marginTop: '8px', background: i < current ? 'var(--primary)' : 'var(--border)' }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};

const PlatformAccountRow: React.FC<{ entry: PlatformEntry }> = ({ entry }) => {
  const { platform, live, uc, activeGroups, queuedRequests } = entry;
  const { refreshUserCreation } = useAuth();
  const queryClient = useQueryClient();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [busy, setBusy] = useState<null | 'retry' | 'sync'>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const label = platformDisplayName(platform);
  const meta = PLATFORMS.find((p) => p.id === platform);
  const status = uc?.status ?? null;
  const ChipIcon = (meta && (Icons as any)[meta.iconName]) || Icons.Box;

  const refresh = async () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.userCreations() });
    queryClient.invalidateQueries({ queryKey: queryKeys.userCreation(platform) });
    queryClient.invalidateQueries({ queryKey: queryKeys.myAccess() });
    queryClient.invalidateQueries({ queryKey: queryKeys.myRequests() });
    await refreshUserCreation();
  };

  const handleRetry = async () => {
    setBusy('retry');
    setMessage(null);
    try {
      await resendInvite(platform);
      await refresh();
      setMessage({ kind: 'success', text: 'Setup link regenerated. Use "Finish setup" below.' });
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
      await syncUserCreationStatusNow(platform);
      await refresh();
      setMessage({ kind: 'success', text: `Synced with ${label}. If your account is ready, this reflects it now.` });
    } catch (err: any) {
      setMessage({ kind: 'error', text: err.message || 'Sync failed.' });
    } finally {
      setBusy(null);
    }
  };

  const pill = ((): { cls: string; label: string; Icon: any } => {
    switch (status) {
      case 'COMPLETED':
        return { cls: 'badge-approved', label: 'Active', Icon: Icons.CheckCircle2 };
      case 'AWAITING_SETUP':
        return { cls: 'badge-pending', label: 'Awaiting setup', Icon: Icons.Clock };
      case 'PENDING':
        return { cls: 'badge-pending', label: 'Pending review', Icon: Icons.Clock };
      case 'APPROVED':
        return { cls: 'badge-rejected', label: 'Action needed', Icon: Icons.AlertTriangle };
      case 'REJECTED':
        return { cls: 'badge-rejected', label: 'Rejected', Icon: Icons.XCircle };
      default:
        return { cls: 'badge-revoked', label: 'No account', Icon: Icons.CircleDashed };
    }
  })();

  const sub = ((): string => {
    switch (status) {
      case 'COMPLETED': {
        const parts = [activeGroups > 0 ? `Active · ${activeGroups} group${activeGroups === 1 ? '' : 's'}` : 'Account active'];
        if (uc?.completedAt) parts.push(`set up ${formatDate(uc.completedAt)}`);
        return parts.join(' · ');
      }
      case 'AWAITING_SETUP':
        return uc?.inviteLink
          ? 'Approved — finish setup to activate your account'
          : `Approved — check your email for ${label} sign-in instructions`;
      case 'PENDING':
        return uc?.submittedAt ? `Submitted ${timeAgo(uc.submittedAt)} · waiting for an admin` : 'Waiting for an admin to review';
      case 'APPROVED':
        return 'Approved, but setup hit a snag — retry to finish';
      case 'REJECTED':
        return 'Your account request was rejected';
      default:
        return meta?.description ?? 'No account yet';
    }
  })();

  const actions = ((): React.ReactNode => {
    switch (status) {
      case 'COMPLETED':
        return live?.launchUrl ? (
          <a
            href={live.launchUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="btn btn-primary btn-sm"
            style={btnSm}
          >
            Open {label} <Icons.ExternalLink size={14} />
          </a>
        ) : null;
      case 'AWAITING_SETUP':
        return (
          <>
            {uc?.inviteLink && (
              <a
                href={uc.inviteLink}
                target="_blank"
                rel="noreferrer noopener"
                className="btn btn-primary"
                style={{ ...btnSm, display: 'inline-flex', alignItems: 'center' }}
              >
                Finish setup <Icons.ArrowRight size={14} />
              </a>
            )}
            <button type="button" className="btn btn-outline btn-sm" style={btnSm} onClick={handleSync} disabled={busy !== null}>
              <Icons.RefreshCw size={14} /> {busy === 'sync' ? 'Syncing…' : "I've finished"}
            </button>
          </>
        );
      case 'APPROVED':
        return (
          <button type="button" className="btn btn-primary btn-sm" style={btnSm} onClick={handleRetry} disabled={busy !== null}>
            <Icons.RefreshCw size={14} /> {busy === 'retry' ? 'Retrying…' : 'Retry setup'}
          </button>
        );
      case 'PENDING':
        return null;
      case 'REJECTED':
        return (
          <button type="button" className="btn btn-primary btn-sm" style={btnSm} onClick={() => setIsFormOpen(true)}>
            <Icons.Send size={14} /> Request again
          </button>
        );
      default:
        return (
          <button type="button" className="btn btn-primary btn-sm" style={btnSm} onClick={() => setIsFormOpen(true)}>
            <Icons.Send size={14} /> Request account
          </button>
        );
    }
  })();

  const step = stepState(status);
  const tieIn =
    queuedRequests > 0 && (status === 'AWAITING_SETUP' || status === 'APPROVED' || status === 'PENDING')
      ? `${queuedRequests} access request${queuedRequests === 1 ? '' : 's'} will activate automatically once your account is ready.`
      : null;
  const approvedError = status === 'APPROVED' && uc?.inviteError ? uc.inviteError : null;
  const rejectedReason = status === 'REJECTED' && uc?.rejectionReason ? uc.rejectionReason : null;
  const pendingJustification = status === 'PENDING' && uc?.justification ? uc.justification : null;
  const hasDetail = !!(message || step || tieIn || approvedError || rejectedReason || pendingJustification);

  return (
    <>
      <div
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '16px 20px',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div
            style={{
              width: '40px',
              height: '40px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-app)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <ChipIcon size={20} style={{ color: meta?.color ?? 'var(--primary)' }} />
          </div>

          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: '15px' }}>{label}</span>
              <span className={`badge ${pill.cls} badge-sm`} style={{ gap: '5px' }}>
                <pill.Icon size={12} /> {pill.label}
              </span>
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '3px' }}>{sub}</div>
          </div>

          {actions && <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>{actions}</div>}
        </div>

        {hasDetail && (
          <div
            style={{
              marginTop: '14px',
              paddingTop: '14px',
              borderTop: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            {step && <LifecycleStepper current={step.current} errored={step.errored} />}

            {tieIn && (
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Icons.Layers size={14} /> {tieIn}
              </div>
            )}

            {approvedError && (
              <div
                style={{
                  background: 'var(--status-rejected-bg)',
                  color: 'var(--status-rejected-text)',
                  border: '1px solid var(--status-rejected-text)',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius-md)',
                  fontSize: '13px',
                }}
              >
                <strong>Last error:</strong> {approvedError}
              </div>
            )}

            {rejectedReason && (
              <blockquote
                style={{
                  margin: 0,
                  padding: '10px 14px',
                  background: 'var(--status-rejected-bg)',
                  color: 'var(--status-rejected-text)',
                  borderLeft: '3px solid var(--status-rejected-text)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '13px',
                  fontStyle: 'italic',
                }}
              >
                "{rejectedReason}"
              </blockquote>
            )}

            {pendingJustification && (
              <blockquote
                style={{
                  margin: 0,
                  padding: '10px 14px',
                  background: 'var(--bg-app)',
                  borderLeft: '3px solid var(--primary)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '13px',
                  color: 'var(--text-muted)',
                  fontStyle: 'italic',
                }}
              >
                "{pendingJustification}"
              </blockquote>
            )}

            {message && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontSize: '13px',
                  fontWeight: 600,
                  color: message.kind === 'success' ? 'var(--status-approved-text)' : 'var(--status-rejected-text)',
                }}
              >
                {message.kind === 'success' ? <Icons.CheckCircle2 size={16} /> : <Icons.AlertTriangle size={16} />}
                <span style={{ flex: 1 }}>{message.text}</span>
                <button
                  type="button"
                  onClick={() => setMessage(null)}
                  style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}
                >
                  <Icons.X size={14} />
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <UserCreationFormModal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        platform={platform}
        platformName={label}
        onSubmitted={() => {
          /* invalidation handled inside the modal */
        }}
      />
    </>
  );
};

export default AccountStatusPanel;
