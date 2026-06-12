import React from 'react';

/** Single shimmering text line. */
export const SkeletonText: React.FC<{ width?: string }> = ({ width = '100%' }) => (
  <div className="skeleton skeleton-text" style={{ width }} />
);

/** Stack of shimmering row placeholders — drop-in for a loading list/table body. */
export const SkeletonRows: React.FC<{ count?: number }> = ({ count = 3 }) => (
  <div aria-hidden="true">
    {Array.from({ length: count }, (_, i) => (
      <div key={i} className="skeleton skeleton-row" />
    ))}
  </div>
);
