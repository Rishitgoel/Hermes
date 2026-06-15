import React from 'react';

interface SectionHeaderProps {
  /** Section title — one consistent size across every page (a step below the TopBar title). */
  title: string;
  /** Optional leading icon (a lucide icon element, e.g. <Icons.Layers size={18} />). */
  icon?: React.ReactNode;
  /** Right-aligned muted summary text, e.g. "3 Requests Total" / "2 platforms · 2 active". */
  meta?: React.ReactNode;
  /** Right-aligned actions, e.g. a "New group" button. */
  actions?: React.ReactNode;
  /** Optional one-line muted description under the title. */
  description?: string;
  /** Extra props on the outer row (style/ref hooks used by a couple of pages). */
  className?: string;
  style?: React.CSSProperties;
}

/**
 * The single section-header used across all pages. Gives every in-content section
 * one consistent heading level (title left; meta + actions right), replacing the
 * old per-page mix of 28px <h1> page titles and 20px <h2>/<h3> section heads.
 */
export const SectionHeader: React.FC<SectionHeaderProps> = ({
  title,
  icon,
  meta,
  actions,
  description,
  className,
  style,
}) => {
  return (
    <div className={`section-head${className ? ` ${className}` : ''}`} style={style}>
      <div className="section-head-main">
        <h2 className="section-head-title">
          {icon}
          {title}
        </h2>
        {description && <div className="section-head-desc">{description}</div>}
      </div>
      {(meta || actions) && (
        <div className="section-head-right">
          {meta && <span className="section-head-meta">{meta}</span>}
          {actions}
        </div>
      )}
    </div>
  );
};

export default SectionHeader;
