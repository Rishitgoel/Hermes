import React from 'react';
import { detectType, isLargeValue, previewValue, tooltipValue, TYPE_META, type ValueType } from '../../lib/valueFormat';
import { JsonViewerButton, type ViewerSection } from './JsonValueViewer';

/**
 * Inline preview of a value (optionally a before → after diff) that never overflows its container:
 * a small type badge, a length-capped single-line preview that ellipsizes, and — when the value is
 * large (JSON / multi-line / long) — an expand button that opens the full JSON viewer.
 *
 * Uses the same detection algorithm as the ZooKeeper trees (`lib/valueFormat`), so a JSON secret
 * value reads the same way everywhere.
 */

/** Small colored chip labelling a value's inferred type. */
const TypeChip: React.FC<{ type: ValueType }> = ({ type }) => {
  if (type === 'empty') return null;
  const m = TYPE_META[type];
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        color: m.color,
        border: `1px solid ${m.color}`,
        borderRadius: 4,
        padding: '0 4px',
        lineHeight: '15px',
        flexShrink: 0,
      }}
    >
      {m.label}
    </span>
  );
};

const clip: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
};

export const ValuePreview: React.FC<{
  value: string | null | undefined;
  /** When provided and different from `value`, renders a struck old → new diff. */
  previousValue?: string | null;
  /** Title for the expanded viewer modal (e.g. the key name). */
  viewerTitle?: React.ReactNode;
  /** Rendered when the value is null/undefined (e.g. redacted secrets). */
  emptyLabel?: React.ReactNode;
  /** Show the inferred-type badge (json/array/num/bool/str) before the preview. Default true. */
  showTypeChip?: boolean;
}> = ({ value, previousValue, viewerTitle, emptyLabel, showTypeChip = true }) => {
  if (value === null || value === undefined) {
    return (
      <span style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>
        {emptyLabel ?? '(empty)'}
      </span>
    );
  }

  const isDiff = previousValue !== null && previousValue !== undefined && previousValue !== value;
  const large = isLargeValue(value) || (isDiff && isLargeValue(previousValue));

  const sections: ViewerSection[] = isDiff
    ? [
        { label: 'Before', value: previousValue, tone: 'old' },
        { label: 'After', value, tone: 'new' },
      ]
    : [{ label: 'Value', value, tone: 'neutral' }];

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%' }}>
      {showTypeChip && <TypeChip type={detectType(value)} />}
      {isDiff ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%' }}>
          <span title={tooltipValue(previousValue)} style={{ ...clip, textDecoration: 'line-through', color: 'var(--text-muted)' }}>
            {previewValue(previousValue)}
          </span>
          <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>→</span>
          <span title={tooltipValue(value)} style={{ ...clip }}>
            {previewValue(value)}
          </span>
        </span>
      ) : (
        <span title={tooltipValue(value)} style={{ ...clip }}>
          {previewValue(value) || <em style={{ color: 'var(--text-light)' }}>(empty)</em>}
        </span>
      )}
      {large && <JsonViewerButton title={viewerTitle ?? 'Value'} sections={sections} />}
    </span>
  );
};

export default ValuePreview;
