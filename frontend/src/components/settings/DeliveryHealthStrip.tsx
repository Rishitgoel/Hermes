import React from 'react';
import { useMutation } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import {
  sendTestNotification,
  type DeliveryHealth,
  type NotificationChannel,
} from '../../services/api/notificationSettings';

interface DeliveryHealthStripProps {
  health: DeliveryHealth;
}

/**
 * Whether each transport is actually wired up. A switch being on means nothing
 * if EMAIL_FROM or SLACK_BOT_TOKEN was never configured — this strip is what
 * stops someone concluding "notifications are enabled" from the grid alone.
 *
 * The test buttons bypass the switchboard on purpose: they prove the transport
 * works, so they must still fire when a scenario (or a master) is switched off.
 */
export const DeliveryHealthStrip: React.FC<DeliveryHealthStripProps> = ({ health }) => {
  const toast = useToast();

  const testMutation = useMutation({
    mutationFn: (channel: NotificationChannel) => sendTestNotification(channel),
    onSuccess: (result) => {
      if (result.delivered) {
        toast.success(`Test ${result.channel === 'email' ? 'email' : 'Slack DM'} sent to ${result.recipient}.`);
      } else if (result.simulated) {
        toast.info(`${result.channel === 'email' ? 'Email' : 'Slack'} is in simulation mode — the test was logged, not sent.`);
      } else {
        toast.error(`Could not deliver the test: ${result.reason ?? 'unknown error'}`);
      }
    },
    onError: (e: any) => toast.error(e.message || 'Failed to send the test.'),
  });

  const pending = (channel: NotificationChannel) =>
    testMutation.isPending && testMutation.variables === channel;

  return (
    <div className="health-strip">
      <div className="health-chip">
        <span className={`health-dot ${health.email.live ? 'is-live' : 'is-sim'}`} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="health-name">Email {health.email.live ? '· live' : '· simulated'}</div>
          <div className="health-detail">
            {health.email.live
              ? `${health.email.from}${health.email.region ? ` · ${health.email.region}` : ''}`
              : health.email.reason}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => testMutation.mutate('email')}
          disabled={testMutation.isPending}
        >
          {pending('email') ? 'Sending…' : 'Send test'}
        </button>
      </div>

      <div className="health-chip">
        <span className={`health-dot ${health.slackDm.live ? 'is-live' : 'is-sim'}`} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="health-name">Slack DM {health.slackDm.live ? '· live' : '· simulated'}</div>
          <div className="health-detail">
            {health.slackDm.live ? 'Bot token configured' : health.slackDm.reason}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => testMutation.mutate('slack')}
          disabled={testMutation.isPending}
        >
          {pending('slack') ? 'Sending…' : 'Send test'}
        </button>
      </div>
    </div>
  );
};

export default DeliveryHealthStrip;
