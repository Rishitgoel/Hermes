import config from '../config/config';

/**
 * Tiny HTML email builder. Email clients ignore <style>/external CSS, so every
 * style here is inline. Each template returns { subject, html, text } ready to
 * hand to EmailService.sendEmail. Keep these dependency-free and simple.
 */

const BRAND = '#4f46e5';
const TEXT = '#1f2937';
const MUTED = '#6b7280';
const BORDER = '#e5e7eb';

/** HTML-escape user-supplied values before interpolating into markup. */
function esc(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function url(path: string): string {
  return `${config.frontend.url}${path}`;
}

interface LayoutOpts {
  heading: string;
  bodyHtml: string;
  ctaLabel?: string;
  ctaHref?: string;
}

function layout({ heading, bodyHtml, ctaLabel, ctaHref }: LayoutOpts): string {
  const button =
    ctaLabel && ctaHref
      ? `<tr><td style="padding-top:24px;">
           <a href="${ctaHref}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:14px;">${esc(ctaLabel)}</a>
         </td></tr>`
      : '';

  return `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden;max-width:560px;width:100%;">
          <tr><td style="background:${BRAND};padding:18px 28px;">
            <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.3px;">Hermes</span>
          </td></tr>
          <tr><td style="padding:28px;">
            <h1 style="margin:0 0 12px;font-size:20px;color:${TEXT};">${esc(heading)}</h1>
            <table role="presentation" cellpadding="0" cellspacing="0" style="color:${TEXT};font-size:15px;line-height:1.6;">
              <tr><td>${bodyHtml}</td></tr>
              ${button}
            </table>
          </td></tr>
          <tr><td style="padding:16px 28px;border-top:1px solid ${BORDER};">
            <p style="margin:0;color:${MUTED};font-size:12px;line-height:1.5;">Hermes — internal access management. This is an automated message; please don't reply directly.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

// ── Admin-facing ──────────────────────────────────────────────

export function adminNewAccountRequest(opts: {
  userName: string;
  userEmail: string;
  justification: string | null;
  /** Human-friendly platform name (e.g. "Redash", "AWS"); falls back to "platform". */
  platformLabel?: string;
}): EmailContent {
  const href = url('/pending-approvals');
  const label = opts.platformLabel || 'platform';
  const reason = opts.justification ? `<p style="margin:12px 0 0;"><strong>Reason:</strong> ${esc(opts.justification)}</p>` : '';
  return {
    subject: `[Hermes] New account request from ${opts.userName}`,
    html: layout({
      heading: 'New account request',
      bodyHtml: `<p style="margin:0;"><strong>${esc(opts.userName)}</strong> (${esc(opts.userEmail)}) has requested a <strong>${esc(label)}</strong> account.</p>${reason}<p style="margin:12px 0 0;">Review and approve it in Hermes.</p>`,
      ctaLabel: 'Review request',
      ctaHref: href,
    }),
    text: `${opts.userName} (${opts.userEmail}) requested a ${label} account.${opts.justification ? ` Reason: ${opts.justification}.` : ''} Review: ${href}`,
  };
}

export function adminNewGroupRequest(opts: {
  requesterName: string;
  groupName: string;
  justification: string;
  duration: string;
}): EmailContent {
  const href = url('/pending-approvals');
  const durationLabel = opts.duration.replace(/_/g, ' ').toLowerCase();
  return {
    subject: `[Hermes] ${opts.requesterName} requested access to ${opts.groupName}`,
    html: layout({
      heading: 'New access request',
      bodyHtml: `<p style="margin:0;"><strong>${esc(opts.requesterName)}</strong> requested access to the <strong>${esc(opts.groupName)}</strong> group.</p><p style="margin:12px 0 0;"><strong>Reason:</strong> ${esc(opts.justification)}</p><p style="margin:6px 0 0;"><strong>Duration:</strong> ${esc(durationLabel)}</p>`,
      ctaLabel: 'Review request',
      ctaHref: href,
    }),
    text: `${opts.requesterName} requested access to ${opts.groupName} (${durationLabel}). Reason: ${opts.justification}. Review: ${href}`,
  };
}

export function adminNewGroupRequestsBulk(opts: {
  requesterName: string;
  groupLabels: string[];
  duration: string;
}): EmailContent {
  const href = url('/pending-approvals');
  const durationLabel = opts.duration.replace(/_/g, ' ').toLowerCase();
  const list = opts.groupLabels.map((g) => `<li style="margin-bottom:4px;">${esc(g)}</li>`).join('');
  return {
    subject: `[Hermes] ${opts.requesterName} requested access to ${opts.groupLabels.length} group(s)`,
    html: layout({
      heading: 'New access requests',
      bodyHtml: `<p style="margin:0;"><strong>${esc(opts.requesterName)}</strong> requested access to the following group(s):</p><ul style="margin:12px 0 0;padding-left:20px;color:${TEXT};">${list}</ul><p style="margin:12px 0 0;"><strong>Duration:</strong> ${esc(durationLabel)}</p>`,
      ctaLabel: 'Review requests',
      ctaHref: href,
    }),
    text: `${opts.requesterName} requested access to ${opts.groupLabels.length} group(s): ${opts.groupLabels.join(', ')} (${durationLabel}). Review: ${href}`,
  };
}

export function adminZkChangeRequest(opts: {
  requesterName: string;
  groupName: string;
  changeCount: number;
  justification?: string | null;
}): EmailContent {
  const href = url('/pending-approvals');
  const reason = opts.justification
    ? `<p style="margin:12px 0 0;"><strong>Reason:</strong> ${esc(opts.justification)}</p>`
    : '';
  return {
    subject: `[Hermes] ${opts.requesterName} proposed ${opts.changeCount} ZooKeeper config change(s)`,
    html: layout({
      heading: 'New ZooKeeper config change request',
      bodyHtml: `<p style="margin:0;"><strong>${esc(opts.requesterName)}</strong> proposed <strong>${opts.changeCount}</strong> configuration change(s) for the <strong>${esc(opts.groupName)}</strong> group.</p>${reason}<p style="margin:12px 0 0;">Review the diff and approve or reject it in Hermes.</p>`,
      ctaLabel: 'Review change request',
      ctaHref: href,
    }),
    text: `${opts.requesterName} proposed ${opts.changeCount} ZooKeeper config change(s) for ${opts.groupName}.${opts.justification ? ` Reason: ${opts.justification}.` : ''} Review: ${href}`,
  };
}

// ── User-facing ───────────────────────────────────────────────

export function userZkChangeReviewed(opts: {
  groupName: string;
  status: 'APPLIED' | 'PARTIALLY_APPLIED' | 'APPLY_FAILED' | 'REJECTED';
  reviewerName: string;
  note?: string;
  approved?: number;
  rejected?: number;
}): EmailContent {
  const href = url('/zookeeper');
  const approved = opts.approved ?? 0;
  const rejected = opts.rejected ?? 0;
  const noteHtml = opts.note ? `<p style="margin:12px 0 0;"><strong>Note:</strong> ${esc(opts.note)}</p>` : '';
  const copy: Record<typeof opts.status, { heading: string; line: string }> = {
    APPLIED: { heading: 'Config change applied ✅', line: `all ${approved} change(s) were approved and applied` },
    PARTIALLY_APPLIED: { heading: 'Config change partially applied', line: `${approved} change(s) approved &amp; applied, ${rejected} rejected` },
    APPLY_FAILED: { heading: 'Config change needs attention', line: `${approved} change(s) were approved but one or more failed to apply — an admin will follow up` },
    REJECTED: { heading: 'Config change declined', line: 'your change(s) were rejected' },
  };
  const { heading, line } = copy[opts.status];
  return {
    subject: `[Hermes] ZooKeeper config change reviewed: ${opts.groupName}`,
    html: layout({
      heading,
      bodyHtml: `<p style="margin:0;">Your ZooKeeper configuration request for <strong>${esc(opts.groupName)}</strong> was reviewed by ${esc(opts.reviewerName)} — ${line}.</p>${noteHtml}`,
      ctaLabel: 'Open ZooKeeper Config',
      ctaHref: href,
    }),
    text: `Your ZooKeeper config request for ${opts.groupName} was reviewed by ${opts.reviewerName}: ${line.replace('&amp;', '&')}.${opts.note ? ` Note: ${opts.note}.` : ''} ${href}`,
  };
}

export function userAccountApproved(opts: { reviewerName: string; platformLabel?: string }): EmailContent {
  const href = url('/my-requests');
  const label = opts.platformLabel || 'the platform';
  return {
    subject: '[Hermes] Your account has been approved',
    html: layout({
      heading: 'Your account is approved 🎉',
      bodyHtml: `<p style="margin:0;">${esc(opts.reviewerName)} approved your Hermes account.</p><p style="margin:12px 0 0;">Check your inbox for a separate email from ${esc(label)} with a link to create your password.</p>`,
      ctaLabel: 'View account status',
      ctaHref: href,
    }),
    text: `${opts.reviewerName} approved your Hermes account. Check your inbox for the ${label} link to create your password. ${href}`,
  };
}

export function userAccountSetupComplete(opts: { platformLabel: string }): EmailContent {
  const href = url('/');
  const label = opts.platformLabel;
  return {
    subject: '[Hermes] Your account is fully set up',
    html: layout({
      heading: 'You’re all set 🎉',
      bodyHtml: `<p style="margin:0;">You’ve activated your ${esc(label)} account — your Hermes account is fully active, and any group memberships already approved by an admin have been provisioned.</p>`,
      ctaLabel: 'Open Hermes',
      ctaHref: href,
    }),
    text: `You've activated your ${label} account — your Hermes account is fully active and any approved group memberships have been provisioned. ${href}`,
  };
}

/**
 * AWS Identity Center onboarding. AWS does NOT email API-created users, so this is
 * the activation nudge: the user sets their own password via the access portal's
 * "Forgot password" flow. `portalUrl` is the SSO start URL (config.aws.accessPortalUrl);
 * the CTA button is omitted if it isn't configured.
 */
export function userAwsAccountReady(opts: { portalUrl: string }): EmailContent {
  const portalLine = opts.portalUrl
    ? `<p style="margin:6px 0 0;color:${MUTED};font-size:13px;">Portal: ${esc(opts.portalUrl)}</p>`
    : `<p style="margin:6px 0 0;color:${MUTED};font-size:13px;">Ask your admin for your organization's AWS access portal URL.</p>`;
  return {
    subject: '[Hermes] Your AWS access is ready — set your password',
    html: layout({
      heading: 'Your AWS account is ready 🎉',
      bodyHtml: `<p style="margin:0;">Your AWS access has been set up. To sign in for the first time:</p>
        <ol style="margin:12px 0 0;padding-left:20px;color:${TEXT};">
          <li style="margin-bottom:6px;">Open the AWS access portal${opts.portalUrl ? ' (button below)' : ''}.</li>
          <li style="margin-bottom:6px;">Click <strong>Forgot password</strong> and enter <strong>this email address</strong> to set your password.</li>
          <li>Follow the prompts (including MFA setup, if required), then sign in.</li>
        </ol>
        ${portalLine}
        <p style="margin:12px 0 0;color:${MUTED};font-size:13px;">Any group access an admin has approved is already attached to your account — it'll be available as soon as you sign in.</p>`,
      ctaLabel: opts.portalUrl ? 'Open AWS access portal' : undefined,
      ctaHref: opts.portalUrl || undefined,
    }),
    text: `Your AWS access is ready. Open the AWS access portal${opts.portalUrl ? ` (${opts.portalUrl})` : ''}, click "Forgot password" with this email to set your password, complete MFA setup if prompted, and sign in. Approved group access is already attached to your account.`,
  };
}

/**
 * ZooKeeper onboarding. Hermes is the identity issuer for the `digest` scheme, so it
 * mints and delivers the one-time credential here (ZooKeeper itself sends nothing).
 * `username`/`password` are absent on a generic completion (no credential to show) —
 * the copy degrades to "your access is set up". The credential is shown once and is
 * not stored by Hermes.
 */
export function userZookeeperAccountReady(opts: {
  username?: string;
  password?: string;
  connectString?: string;
}): EmailContent {
  const haveCreds = !!(opts.username && opts.password);
  const connect = opts.connectString || '';
  if (!haveCreds) {
    return {
      subject: '[Hermes] Your ZooKeeper access is ready',
      html: layout({
        heading: 'Your ZooKeeper access is ready 🎉',
        bodyHtml: `<p style="margin:0;">Your ZooKeeper access has been set up. Any group access an admin has approved is already attached to your identity.</p>`,
      }),
      text: 'Your ZooKeeper access is ready. Any approved group access is already attached to your identity.',
    };
  }
  const connectLine = connect
    ? `<p style="margin:6px 0 0;color:${MUTED};font-size:13px;">Connect string: <code>${esc(connect)}</code></p>`
    : '';
  return {
    subject: '[Hermes] Your ZooKeeper credential (shown once)',
    html: layout({
      heading: 'Your ZooKeeper access is ready 🔑',
      bodyHtml: `<p style="margin:0;">Your ZooKeeper access has been set up. Here is your credential — <strong>store it now; it is shown only once</strong> and Hermes does not keep a copy:</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0 0;border:1px solid ${BORDER};border-radius:8px;background:#f9fafb;width:100%;">
          <tr><td style="padding:10px 14px;color:${TEXT};font-size:14px;">
            <div><strong>Username:</strong> <code>${esc(opts.username)}</code></div>
            <div style="margin-top:6px;"><strong>Password:</strong> <code>${esc(opts.password)}</code></div>
          </td></tr>
        </table>
        <p style="margin:14px 0 0;color:${TEXT};">Authenticate in your ZooKeeper client with:</p>
        <pre style="margin:6px 0 0;padding:10px 14px;background:#0f172a;color:#e2e8f0;border-radius:8px;font-size:13px;overflow:auto;">addauth digest ${esc(opts.username)}:${esc(opts.password)}</pre>
        ${connectLine}
        <p style="margin:14px 0 0;color:${MUTED};font-size:13px;">Any group access an admin has approved is already attached to this identity.</p>`,
    }),
    text:
      `Your ZooKeeper access is ready. Store this credential now — it is shown only once and Hermes keeps no copy.\n` +
      (connect ? `Connect string: ${connect}\n` : '') +
      `Username: ${opts.username}\nPassword: ${opts.password}\n` +
      `Authenticate with: addauth digest ${opts.username}:${opts.password}\n` +
      `Approved group access is already attached to this identity.`,
  };
}

export function userAccountRejected(opts: { reviewerName: string; note?: string }): EmailContent {
  const href = url('/my-requests');
  const noteHtml = opts.note ? `<p style="margin:12px 0 0;"><strong>Reason:</strong> ${esc(opts.note)}</p>` : '';
  return {
    subject: '[Hermes] Your account request was declined',
    html: layout({
      heading: 'Account request declined',
      bodyHtml: `<p style="margin:0;">${esc(opts.reviewerName)} declined your Hermes account request.</p>${noteHtml}`,
      ctaLabel: 'View details',
      ctaHref: href,
    }),
    text: `${opts.reviewerName} declined your Hermes account request.${opts.note ? ` Reason: ${opts.note}.` : ''} ${href}`,
  };
}

export function userGroupApproved(opts: { groupName: string; reviewerName: string; note?: string }): EmailContent {
  const href = url('/');
  const noteHtml = opts.note ? `<p style="margin:12px 0 0;"><strong>Note:</strong> ${esc(opts.note)}</p>` : '';
  return {
    subject: `[Hermes] Access approved: ${opts.groupName}`,
    html: layout({
      heading: 'Access request approved ✅',
      bodyHtml: `<p style="margin:0;">Your access request to the <strong>${esc(opts.groupName)}</strong> group was approved by ${esc(opts.reviewerName)}.</p>${noteHtml}`,
      ctaLabel: 'Open Hermes',
      ctaHref: href,
    }),
    text: `Your access request to ${opts.groupName} was approved by ${opts.reviewerName}.${opts.note ? ` Note: ${opts.note}.` : ''} ${href}`,
  };
}

export function userGroupRejected(opts: { groupName: string; reviewerName: string; note?: string }): EmailContent {
  const href = url('/my-requests');
  const noteHtml = opts.note ? `<p style="margin:12px 0 0;"><strong>Reason:</strong> ${esc(opts.note)}</p>` : '';
  return {
    subject: `[Hermes] Access request declined: ${opts.groupName}`,
    html: layout({
      heading: 'Access request declined',
      bodyHtml: `<p style="margin:0;">Your access request to the <strong>${esc(opts.groupName)}</strong> group was rejected by ${esc(opts.reviewerName)}.</p>${noteHtml}`,
      ctaLabel: 'View my requests',
      ctaHref: href,
    }),
    text: `Your access request to ${opts.groupName} was rejected by ${opts.reviewerName}.${opts.note ? ` Reason: ${opts.note}.` : ''} ${href}`,
  };
}
