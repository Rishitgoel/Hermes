import apiClient from '../apiClient';

/**
 * The global notification switchboard — super admin only, enforced server-side.
 *
 * The catalogue (labels, grouping, which channels a scenario even uses) is served
 * by the backend rather than duplicated here, so the grid can never drift from
 * what `notification.service.ts` actually sends. apiClient unwraps the response
 * envelope, so each call resolves to the payload.
 */

export type NotificationChannel = 'email' | 'slack';

/** 'na' means this scenario never delivers on that channel — no switch is shown. */
export type ChannelState = 'on' | 'off' | 'na';

export interface NotificationCategory {
  key: string;
  label: string;
  description: string;
}

export interface NotificationScenarioRow {
  key: string;
  category: string;
  label: string;
  description: string;
  audience: 'admin' | 'user';
  credentialBearing: boolean;
  channels: Record<NotificationChannel, ChannelState>;
}

export interface DeliveryHealth {
  email: {
    live: boolean;
    from: string | null;
    region: string | null;
    reason: string | null;
  };
  slackDm: { live: boolean; reason: string | null };
}

export interface NotificationSettingsPayload {
  categories: NotificationCategory[];
  scenarios: NotificationScenarioRow[];
  /** The two kill switches. Effective state is master AND per-scenario. */
  masters: Record<NotificationChannel, boolean>;
  health: DeliveryHealth;
  /** Seconds a change can take to reach every backend replica. */
  propagationSeconds: number;
}

export interface TestSendResult {
  channel: NotificationChannel;
  recipient: string;
  delivered: boolean;
  simulated: boolean;
  reason: string | null;
}

export async function getNotificationSettings(): Promise<NotificationSettingsPayload> {
  const res = await apiClient.get('/api/admin/notification-settings');
  return res.data as NotificationSettingsPayload;
}

/** Flip one switch. Pass scenario `'master'` for a kill switch. */
export async function updateNotificationSetting(
  scenario: string,
  channel: NotificationChannel,
  enabled: boolean,
): Promise<{ scenario: string; channel: NotificationChannel; enabled: boolean }> {
  const res = await apiClient.post('/api/admin/notification-settings', {
    scenario,
    channel,
    enabled,
  });
  return res.data;
}

/**
 * Send a sample message to your own address to prove the transport works.
 * Deliberately ignores the switchboard — it tests SES / the Slack bot token,
 * not the policy.
 */
export async function sendTestNotification(
  channel: NotificationChannel,
): Promise<TestSendResult> {
  const res = await apiClient.post('/api/admin/notification-settings/test', {
    channel,
  });
  return res.data as TestSendResult;
}
