import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import LoadingSpinner from '../common/LoadingSpinner';
import SectionHeader from '../common/SectionHeader';
import Switch from '../common/Switch';
import DeliveryHealthStrip from './DeliveryHealthStrip';
import { queryKeys } from '../../lib/queryKeys';
import {
  getNotificationSettings,
  updateNotificationSetting,
  type NotificationChannel,
  type NotificationScenarioRow,
  type NotificationSettingsPayload,
} from '../../services/api/notificationSettings';

const CHANNELS: { key: NotificationChannel; label: string }[] = [
  { key: 'email', label: 'Email' },
  { key: 'slack', label: 'Slack' },
];

/**
 * The global switchboard: one row per notification Hermes can send, one switch
 * per delivery channel.
 *
 * In-app notifications are deliberately absent — they are the durable record and
 * the feed behind the bell icon, so they always fire. A row whose channels are
 * all 'na' (currently only "Auto-expiry failed") is still listed, greyed out, so
 * the list reads as complete rather than mysteriously missing entries.
 */
export const NotificationSettingsTab: React.FC = () => {
  const toast = useToast();
  const queryClient = useQueryClient();

  const settingsQuery = useQuery<NotificationSettingsPayload>({
    queryKey: queryKeys.notificationSettings(),
    queryFn: getNotificationSettings,
  });

  const mutation = useMutation({
    mutationFn: ({
      scenario,
      channel,
      enabled,
    }: {
      scenario: string;
      channel: NotificationChannel;
      enabled: boolean;
    }) => updateNotificationSetting(scenario, channel, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notificationSettings() });
    },
    onError: (e: any) => {
      toast.error(e.message || 'Failed to update the setting.');
      // Re-sync from the server so the switch snaps back to the stored value.
      queryClient.invalidateQueries({ queryKey: queryKeys.notificationSettings() });
    },
  });

  if (settingsQuery.isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
        <LoadingSpinner message="Loading notification settings…" />
      </div>
    );
  }

  if (settingsQuery.isError || !settingsQuery.data) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">
          <Icons.AlertTriangle size={28} />
        </div>
        <div className="empty-state-title">Could not load notification settings</div>
        <div className="empty-state-desc">
          {(settingsQuery.error as any)?.message || 'Make sure you have super admin access.'}
        </div>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          style={{ marginTop: 12 }}
          onClick={() => settingsQuery.refetch()}
        >
          Retry
        </button>
      </div>
    );
  }

  const { categories, scenarios, masters, health, propagationSeconds } = settingsQuery.data;

  const isPendingFor = (scenario: string, channel: NotificationChannel) =>
    mutation.isPending &&
    mutation.variables?.scenario === scenario &&
    mutation.variables?.channel === channel;

  const renderScenarioRow = (row: NotificationScenarioRow) => {
    const inert = row.channels.email === 'na' && row.channels.slack === 'na';

    return (
      <div className="notify-row" key={row.key}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="notify-name">{row.label}</span>
            <span className="notify-badge">
              {row.audience === 'admin' ? 'Admin-facing' : 'You-facing'}
            </span>
            {row.credentialBearing && (
              <span className="notify-badge is-credential">
                <Icons.KeyRound size={11} /> Credential
              </span>
            )}
            {inert && <span className="notify-badge">In-app only</span>}
          </div>
          <div className="notify-desc">{row.description}</div>

          {row.credentialBearing && (
            <div className="settings-note is-danger" style={{ marginTop: 8 }}>
              <Icons.AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                Carries login credentials. If you turn this off, people will not receive their
                password or setup link — an admin has to hand it over manually.
              </span>
            </div>
          )}
        </div>

        {CHANNELS.map(({ key, label }) => {
          const state = row.channels[key];
          if (state === 'na') {
            return (
              <div className="notify-cell" key={key}>
                <span className="notify-na" title={`This notification never uses ${label.toLowerCase()}`}>
                  n/a
                </span>
              </div>
            );
          }
          const masterOff = !masters[key];
          return (
            <div className="notify-cell" key={key}>
              <Switch
                aria-label={`${label} for ${row.label}`}
                checked={state === 'on'}
                disabled={masterOff || isPendingFor(row.key, key)}
                title={
                  masterOff
                    ? `All ${label} is switched off above`
                    : undefined
                }
                onChange={(checked) =>
                  mutation.mutate({ scenario: row.key, channel: key, enabled: checked })
                }
              />
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div>
      <SectionHeader
        title="Delivery health"
        icon={<Icons.Activity size={18} />}
        description="Whether each transport is actually configured. A switch that is on still sends nothing if its transport is simulated."
      />
      <DeliveryHealthStrip health={health} />

      <SectionHeader
        title="Master switches"
        icon={<Icons.Power size={18} />}
        description="Mute a whole channel without touching the grid below — useful during a migration or an incident."
        style={{ marginTop: 28 }}
      />
      <div className="settings-card">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {CHANNELS.map(({ key, label }) => (
            <div
              key={key}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}
            >
              <div style={{ minWidth: 0 }}>
                <div className="notify-name">All {label}</div>
                <div className="notify-desc">
                  {key === 'slack'
                    ? 'Covers every direct message Hermes sends.'
                    : 'Covers every notification email Hermes sends.'}
                </div>
              </div>
              <Switch
                aria-label={`All ${label}`}
                checked={masters[key]}
                disabled={isPendingFor('master', key)}
                onChange={(checked) =>
                  mutation.mutate({ scenario: 'master', channel: key, enabled: checked })
                }
              />
            </div>
          ))}
        </div>

        {(!masters.email || !masters.slack) && (
          <div className="settings-note is-warning" style={{ marginTop: 14 }}>
            <Icons.VolumeX size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              {!masters.email && !masters.slack
                ? 'All email and Slack delivery is muted.'
                : `All ${!masters.email ? 'email' : 'Slack'} delivery is muted.`}{' '}
              Per-notification switches below are preserved and will come back exactly as they are
              when you switch this on again. In-app notifications are unaffected.
            </span>
          </div>
        )}
      </div>

      <SectionHeader
        title="Notifications"
        icon={<Icons.Bell size={18} />}
        description="Every notification Hermes can send. In-app notifications are always on and are not listed here."
        meta={`${scenarios.length} notifications`}
        style={{ marginTop: 28 }}
      />

      <div className="settings-note is-muted" style={{ marginBottom: 12 }}>
        <Icons.Clock size={14} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>
          Changes save immediately and take effect across all servers within {propagationSeconds}{' '}
          seconds.
        </span>
      </div>

      <div className="notify-grid">
        <div className="notify-row is-head">
          <div className="notify-col-label" style={{ textAlign: 'left' }}>
            Notification
          </div>
          {CHANNELS.map(({ key, label }) => (
            <div className="notify-col-label" key={key}>
              {label}
              {!masters[key] && (
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--status-pending-text)' }}>
                  muted
                </div>
              )}
            </div>
          ))}
        </div>

        {categories.map((category) => {
          const rows = scenarios.filter((s) => s.category === category.key);
          if (rows.length === 0) {
            return null;
          }
          return (
            <React.Fragment key={category.key}>
              <div className="notify-row is-category">
                <div className="admin-section-label">{category.label}</div>
                <div className="notify-desc">{category.description}</div>
              </div>
              {rows.map(renderScenarioRow)}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

export default NotificationSettingsTab;
