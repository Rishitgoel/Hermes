import React from 'react';
import { CheckCircle2, Clock, AlertTriangle } from 'lucide-react';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Standard expiry pill for a grant:
 *  - null            → green "Permanent"
 *  - > 7 days away   → neutral "Expires {date}"
 *  - ≤ 7 days away   → amber "Expires in {n}d"
 *  - ≤ 48 hours away → red countdown
 * Colors come from the status variables only (dark-mode safe).
 */
export const ExpiryBadge: React.FC<{ expiresAt: string | null }> = ({ expiresAt }) => {
  if (!expiresAt) {
    return (
      <span className="badge badge-approved badge-sm" style={{ gap: '4px' }}>
        <CheckCircle2 size={12} /> Permanent
      </span>
    );
  }

  const msLeft = new Date(expiresAt).getTime() - Date.now();
  const date = new Date(expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  if (msLeft <= 0) {
    return (
      <span className="badge badge-expired badge-sm" style={{ gap: '4px' }}>
        <Clock size={12} /> Expired
      </span>
    );
  }

  if (msLeft <= 2 * DAY_MS) {
    const hoursLeft = Math.max(1, Math.round(msLeft / (60 * 60 * 1000)));
    return (
      <span className="badge badge-rejected badge-sm" style={{ gap: '4px' }} title={`Expires ${date}`}>
        <AlertTriangle size={12} /> Expires in {hoursLeft <= 24 ? `${hoursLeft}h` : `${Math.ceil(msLeft / DAY_MS)}d`}
      </span>
    );
  }

  if (msLeft <= 7 * DAY_MS) {
    const daysLeft = Math.ceil(msLeft / DAY_MS);
    return (
      <span className="badge badge-pending badge-sm" style={{ gap: '4px' }} title={`Expires ${date}`}>
        <Clock size={12} /> Expires in {daysLeft}d
      </span>
    );
  }

  return (
    <span className="badge badge-neutral badge-sm" style={{ gap: '4px' }}>
      <Clock size={12} /> Expires {date}
    </span>
  );
};

/** True when the grant expires within the next 7 days (Extend affordance). */
export const isExpiringSoon = (expiresAt: string | null): boolean =>
  !!expiresAt && new Date(expiresAt).getTime() - Date.now() <= 7 * DAY_MS && new Date(expiresAt).getTime() > Date.now();

export default ExpiryBadge;
