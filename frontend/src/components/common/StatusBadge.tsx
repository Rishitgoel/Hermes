import React from 'react';

interface StatusBadgeProps {
  status: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
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

  return (
    <span className={`badge ${getBadgeClass(status)}`}>
      {getFormatLabel(status)}
    </span>
  );
};

export default StatusBadge;
