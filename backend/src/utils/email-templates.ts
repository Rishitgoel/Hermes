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
}): EmailContent {
  const href = url('/pending-approvals');
  const reason = opts.justification ? `<p style="margin:12px 0 0;"><strong>Reason:</strong> ${esc(opts.justification)}</p>` : '';
  return {
    subject: `[Hermes] New account request from ${opts.userName}`,
    html: layout({
      heading: 'New account request',
      bodyHtml: `<p style="margin:0;"><strong>${esc(opts.userName)}</strong> (${esc(opts.userEmail)}) has requested a Hermes/Redash account.</p>${reason}<p style="margin:12px 0 0;">Review and approve it in Hermes.</p>`,
      ctaLabel: 'Review request',
      ctaHref: href,
    }),
    text: `${opts.userName} (${opts.userEmail}) requested a Hermes account.${opts.justification ? ` Reason: ${opts.justification}.` : ''} Review: ${href}`,
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

// ── User-facing ───────────────────────────────────────────────

export function userAccountApproved(opts: { reviewerName: string }): EmailContent {
  const href = url('/account-status');
  return {
    subject: '[Hermes] Your account has been approved',
    html: layout({
      heading: 'Your account is approved 🎉',
      bodyHtml: `<p style="margin:0;">${esc(opts.reviewerName)} approved your Hermes account.</p><p style="margin:12px 0 0;">Check your inbox for a separate email from Redash with a link to set your password and finish setup.</p>`,
      ctaLabel: 'View account status',
      ctaHref: href,
    }),
    text: `${opts.reviewerName} approved your Hermes account. Check your inbox for the Redash setup email. ${href}`,
  };
}

export function userAccountSetupComplete(): EmailContent {
  const href = url('/');
  return {
    subject: '[Hermes] Your account is fully set up',
    html: layout({
      heading: 'You’re all set 🎉',
      bodyHtml: `<p style="margin:0;">You’ve finished Redash setup — your Hermes account is fully active, and any group memberships already approved by an admin have been provisioned.</p>`,
      ctaLabel: 'Open Hermes',
      ctaHref: href,
    }),
    text: `You've finished Redash setup — your Hermes account is fully active and any approved group memberships have been provisioned. ${href}`,
  };
}

export function userAccountRejected(opts: { reviewerName: string; note?: string }): EmailContent {
  const href = url('/account-status');
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
