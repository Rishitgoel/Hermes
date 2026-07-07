import React from 'react';
import * as Icons from 'lucide-react';
import { ACTION_COLOR, ZK_ROW_FONT, previewValue, tooltipValue } from './zkFormat';
import type { ZkChange, ZkChangeAction } from '../../services/api/zookeeperApi';

/**
 * Shared building blocks for the ZooKeeper directory trees. Both the requester's editable
 * config tree (ZookeeperConfig) and the admin's read-only review tree (ZkChangeApprovals)
 * render their rows through ZkRow, so the two surfaces are pixel-identical — same font,
 * spacing, icons, and value/diff rendering. Anything that should look the same on both
 * trees lives here.
 */

// 15px-wide placeholder so leaf rows line up with folder rows that have a chevron.
const CARET_SPACER = <span style={{ width: 15, display: 'inline-block', flexShrink: 0 }} />;

interface ZkRowProps {
  /** Chevron toggle for a folder; omit on a leaf (a spacer keeps the name aligned). */
  caret?: React.ReactNode;
  icon: React.ReactNode;
  /** A string is rendered with the shared name style; pass a node to override (e.g. a rename input). */
  name: React.ReactNode;
  nameTitle?: string;
  onNameClick?: () => void;
  /** Inline bits right after the name: lock icon, action badge, group label. */
  badges?: React.ReactNode;
  /** Value / diff / inline editor — lives in a flex:1 container that pushes actions to the right. */
  body?: React.ReactNode;
  /** Right-aligned controls (edit/delete, or accept/reject). */
  actions?: React.ReactNode;
  tint?: string;
  dim?: boolean;
  align?: 'center' | 'flex-start';
}

/** One directory row: [caret] [icon] name [badges] [body…] [actions]. */
export const ZkRow: React.FC<ZkRowProps> = ({
  caret,
  icon,
  name,
  nameTitle,
  onNameClick,
  badges,
  body,
  actions,
  tint,
  dim,
  align = 'center',
}) => (
  <div
    className="zk-row"
    style={{
      display: 'flex',
      alignItems: align,
      gap: 8,
      padding: '5px 12px 5px 8px',
      borderRadius: 6,
      fontSize: ZK_ROW_FONT,
      opacity: dim ? 0.5 : 1,
      background: tint,
    }}
  >
    {caret ?? CARET_SPACER}
    {icon}
    {typeof name === 'string' ? (
      <span
        onClick={onNameClick}
        title={nameTitle}
        style={{
          fontSize: ZK_ROW_FONT,
          fontWeight: 600,
          color: 'var(--text-main)',
          whiteSpace: 'nowrap',
          flexShrink: 0,
          cursor: onNameClick ? 'pointer' : 'default',
          marginTop: align === 'flex-start' ? 3 : 0,
        }}
      >
        {name}
      </span>
    ) : (
      name
    )}
    {badges}
    <div style={{ flex: 1, minWidth: 0, marginLeft: 6, display: 'flex', alignItems: align, gap: 6 }}>{body}</div>
    {actions}
  </div>
);

/** Small action badge — CREATE reads as "NEW", the rest as the verb. */
export const ActionBadge: React.FC<{ action: ZkChangeAction }> = ({ action }) => (
  <span
    className="badge badge-sm"
    style={{ color: ACTION_COLOR[action], border: `1px solid ${ACTION_COLOR[action]}`, flexShrink: 0 }}
  >
    {action === 'CREATE' ? 'NEW' : action}
  </span>
);

/**
 * Compact old → new diff for one change, used everywhere a change's value is shown (requester
 * tree, submission cart, approver tree). Old value struck through in red, new value in green;
 * CREATE shows just the new value, DELETE/CLEAR show the terminal state.
 */
export const ZkDiff: React.FC<{ change: ZkChange }> = ({ change }) => {
  const oldP = change.oldValue != null && change.oldValue !== '' ? previewValue(change.oldValue) : null;
  const newP = change.newValue != null && change.newValue !== '' ? previewValue(change.newValue) : null;
  // Large (JSON) values are one unbreakable monospace token — each chip must be allowed
  // to shrink and ellipsize inside the row, with the pretty-printed value on hover.
  const chipStyle: React.CSSProperties = {
    padding: '0 4px',
    borderRadius: 3,
    minWidth: 0,
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
  const Old = (
    <span
      title={tooltipValue(change.oldValue ?? null)}
      style={{ ...chipStyle, background: '#fee2e2', color: '#991b1b', textDecoration: 'line-through' }}
    >
      {oldP}
    </span>
  );
  const New = (
    <span title={tooltipValue(change.newValue ?? null)} style={{ ...chipStyle, background: '#dcfce7', color: '#166534' }}>
      {newP ?? '(empty)'}
    </span>
  );
  const arrow = <Icons.ArrowRight size={12} style={{ color: 'var(--text-light)', flexShrink: 0 }} />;
  const empty = <em style={{ color: 'var(--text-light)' }}>(empty)</em>;

  const wrap = (inner: React.ReactNode) => (
    <span style={{ fontFamily: 'monospace', fontSize: ZK_ROW_FONT, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, minWidth: 0, maxWidth: '100%' }}>
      {inner}
    </span>
  );

  switch (change.action) {
    case 'CREATE':
      if (!newP) return wrap(<span style={{ color: 'var(--text-light)' }}>new folder</span>);
      return wrap(New);
    case 'SET':
      return wrap(
        <>
          {oldP ? Old : empty}
          {arrow}
          {New}
        </>,
      );
    case 'CLEAR':
      return wrap(
        <>
          {oldP ? Old : empty}
          {arrow}
          <em style={{ color: ACTION_COLOR.CLEAR }}>(cleared)</em>
        </>,
      );
    case 'DELETE':
      return wrap(
        <>
          {oldP ? Old : null}
          {oldP ? arrow : null}
          <em style={{ color: ACTION_COLOR.DELETE }}>(node deleted)</em>
        </>,
      );
    default:
      return null;
  }
};
