import React from 'react';

/**
 * Standard empty-state block — wraps the .empty-state CSS classes so pages stop
 * re-rolling their own icon sizes and paddings. Pass the icon already sized
 * (40 is the standard, e.g. <Icons.Users size={40} />).
 */
interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  /** Tighter padding for empty states nested inside a card/section. */
  compact?: boolean;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, description, action, compact = false }) => (
  <div className="empty-state" style={compact ? { padding: '24px' } : undefined}>
    <span className="empty-state-icon">{icon}</span>
    <h3 className="empty-state-title" style={compact ? { fontSize: '15px' } : undefined}>
      {title}
    </h3>
    {description && (
      <p className="empty-state-desc" style={compact ? { fontSize: '13px' } : undefined}>
        {description}
      </p>
    )}
    {action}
  </div>
);

export default EmptyState;
