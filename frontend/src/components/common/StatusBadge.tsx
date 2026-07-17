import React, { useState } from 'react';
import * as Icons from 'lucide-react';

interface StatusBadgeProps {
  status: string;
  error?: string | null;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, error }) => {
  const [showTooltip, setShowTooltip] = useState(false);

  const getBadgeClass = (s: string) => {
    const sLower = s.toLowerCase();
    if (sLower === 'pending' || sLower === 'provisioning') return 'badge-pending';
    if (sLower === 'approved' || sLower === 'provisioned') return 'badge-approved';
    if (sLower === 'rejected' || sLower === 'provision_failed') return 'badge-rejected';
    if (sLower === 'expired') return 'badge-expired';
    if (sLower === 'revoked') return 'badge-revoked';
    return '';
  };

  const getFormatLabel = (s: string) => {
    return s.replace('_', ' ');
  };

  const isFailed = status.toLowerCase() === 'provision_failed';

  return (
    <span
      className={`badge ${getBadgeClass(status)}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        position: 'relative',
        cursor: isFailed && error ? 'help' : 'default',
      }}
      onMouseEnter={() => isFailed && error && setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      title={isFailed && error ? error : undefined}
    >
      {getFormatLabel(status)}
      {isFailed && error && (
        <>
          <Icons.Info size={12} style={{ flexShrink: 0 }} />
          {showTooltip && (
            <div
              className="status-badge-tooltip"
              style={{
                position: 'absolute',
                bottom: '100%',
                left: '50%',
                transform: 'translateX(-50%)',
                marginBottom: '6px',
                backgroundColor: 'var(--tooltip-bg, #1a202c)',
                color: 'var(--tooltip-text, #ffffff)',
                padding: '6px 10px',
                borderRadius: '4px',
                fontSize: '11px',
                whiteSpace: 'normal',
                wordBreak: 'break-word',
                zIndex: 50,
                width: '180px',
                boxShadow: 'var(--shadow-md)',
                pointerEvents: 'none',
                fontWeight: 400,
                lineHeight: 1.3,
                border: '1px solid var(--border)',
                textAlign: 'left',
              }}
            >
              {error}
            </div>
          )}
        </>
      )}
    </span>
  );
};

export default StatusBadge;
