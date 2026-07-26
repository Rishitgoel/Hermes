import React, { useState } from 'react';
import * as Icons from 'lucide-react';
import type { SlackDeliveryResult } from '../../services/api/apolloUsers';

interface TemporaryPasswordPanelProps {
  password: string;
  slack: SlackDeliveryResult;
  onCopyError: (message: string) => void;
}

/** Human-readable cause for a DM that didn't land. */
function describeFailure(slack: SlackDeliveryResult): string {
  if (slack.simulated) {
    return ' (Slack is in simulation mode here).';
  }
  if (slack.reason === 'users_not_found') {
    return ' — no Slack account matches this email.';
  }
  return slack.reason ? ` (${slack.reason}).` : '.';
}

/**
 * Shows a temporary password that could not be delivered over Slack, for manual
 * handover. Shared by the create and resend flows so the "this is your only copy"
 * warning is worded identically in both — the two places it matters most.
 *
 * The password is never persisted anywhere, so whichever modal renders this must
 * also refuse to close by accident while it is on screen.
 */
export const TemporaryPasswordPanel: React.FC<TemporaryPasswordPanelProps> = ({
  password,
  slack,
  onCopyError,
}) => {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onCopyError('Could not copy to clipboard — select the password and copy it manually.');
    }
  };

  return (
    <div
      style={{
        border: '1px solid var(--status-pending-text)',
        borderRadius: '8px',
        padding: '14px',
        background: 'var(--bg-inset)',
      }}
    >
      <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', marginBottom: '10px' }}>
        <Icons.ShieldAlert
          size={16}
          style={{ color: 'var(--status-pending-text)', flexShrink: 0, marginTop: '1px' }}
        />
        <div style={{ fontSize: '12.5px', lineHeight: 1.5 }}>
          <strong>The Slack DM could not be delivered</strong>
          {describeFailure(slack)}
          <br />
          Give them this password another way. It is shown once and is not stored anywhere — closing
          this dialog loses it, and you would have to generate another one.
        </div>
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <code
          style={{
            flex: 1,
            fontFamily: 'monospace',
            fontSize: '14px',
            padding: '8px 10px',
            background: 'var(--bg-body, #fff)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            userSelect: 'all',
            wordBreak: 'break-all',
          }}
        >
          {password}
        </code>
        <button type="button" className="btn btn-outline btn-sm" onClick={copy} style={{ flexShrink: 0 }}>
          {copied ? <Icons.Check size={15} /> : <Icons.Copy size={15} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
};

export default TemporaryPasswordPanel;
