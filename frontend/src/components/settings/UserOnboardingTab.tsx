import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import SectionHeader from '../common/SectionHeader';
import CreateApolloUserModal from '../admin/CreateApolloUserModal';
import ResendApolloPasswordModal from '../admin/ResendApolloPasswordModal';
import { queryKeys } from '../../lib/queryKeys';
import {
  getNotificationSettings,
  type NotificationSettingsPayload,
} from '../../services/api/notificationSettings';

/**
 * Keycloak (Apollo) login provisioning — the account that lets someone sign in to
 * the panel at all, upstream of every platform and group.
 *
 * Lives here rather than on Admin Management because it is platform-agnostic:
 * it was previously wedged above the per-platform tabs, where it read as if it
 * belonged to whichever platform happened to be selected.
 */
export const UserOnboardingTab: React.FC = () => {
  const toast = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [showResend, setShowResend] = useState(false);

  // Shares the notification-settings query (and cache) with the Notifications
  // tab so the warning below always matches what that grid shows.
  const settingsQuery = useQuery<NotificationSettingsPayload>({
    queryKey: queryKeys.notificationSettings(),
    queryFn: getNotificationSettings,
  });

  const slackDmLive = settingsQuery.data?.health.slackDm.live ?? true;
  const apolloRow = settingsQuery.data?.scenarios.find(
    (s) => s.key === 'apollo.credentials.issued',
  );
  const apolloSlackOff =
    apolloRow?.channels.slack === 'off' || settingsQuery.data?.masters.slack === false;

  const willFallBackToScreen = !slackDmLive || apolloSlackOff;

  return (
    <div>
      <SectionHeader
        title="Apollo logins"
        icon={<Icons.KeyRound size={18} />}
        description="Create the Keycloak login a new staff member needs to sign in. They get a random password on Slack and must change it the first time they sign in."
      />

      {willFallBackToScreen && (
        <div className="settings-note is-warning" style={{ marginBottom: 16 }}>
          <Icons.AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            {apolloSlackOff
              ? 'Slack delivery for Apollo temporary passwords is switched off in Notifications.'
              : 'Slack DMs are not configured on this environment.'}{' '}
            The temporary password will be shown on screen once instead — copy it and hand it over
            yourself, because it cannot be retrieved again afterwards.
          </span>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <div className="settings-card" style={{ flex: '1 1 280px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Icons.UserPlus size={16} style={{ color: 'var(--primary)' }} />
            <span className="notify-name">New Apollo login</span>
          </div>
          <div className="notify-desc" style={{ marginBottom: 12 }}>
            Creates the Keycloak account for someone joining the team. Use this before they request
            access to any group or platform.
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}>
            <Icons.UserPlus size={15} /> Create login
          </button>
        </div>

        <div className="settings-card" style={{ flex: '1 1 280px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Icons.RefreshCw size={16} style={{ color: 'var(--primary)' }} />
            <span className="notify-name">Resend temporary password</span>
          </div>
          <div className="notify-desc" style={{ marginBottom: 12 }}>
            Mints a fresh password for an existing login and re-sends it. Use this when the first DM
            never landed, or the password was lost before first sign-in.
          </div>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowResend(true)}>
            <Icons.KeyRound size={15} /> Resend password
          </button>
        </div>
      </div>

      {showCreate && (
        <CreateApolloUserModal
          onClose={() => setShowCreate(false)}
          onCreated={(msg) => toast.success(msg)}
          onError={(msg) => toast.error(msg)}
        />
      )}

      {showResend && (
        <ResendApolloPasswordModal
          onClose={() => setShowResend(false)}
          onDone={(msg) => toast.success(msg)}
          onError={(msg) => toast.error(msg)}
        />
      )}
    </div>
  );
};

export default UserOnboardingTab;
