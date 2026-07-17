import type { ZkChangeAction } from '../../services/api/zookeeperApi';

/**
 * Shared ZooKeeper directory-view formatting — used by both the user's config tree
 * (ZookeeperConfig) and the admin's change-review tree (ZkChangeApprovals) so the two
 * surfaces stay visually identical (colors, value typing, indentation).
 *
 * The value-typing helpers (detectType / previewValue / tooltipValue / prettyValue / …) now
 * live in `lib/valueFormat.ts` so Secret Ingestion can reuse the exact same detection algorithm.
 * They're re-exported here so every existing ZooKeeper import keeps working unchanged.
 */

export {
  type ValueType,
  TYPE_META,
  detectType,
  previewValue,
  tooltipValue,
  prettyValue,
  parsesAsJson,
  isLargeValue,
} from '../../lib/valueFormat';

// Per-level indentation (px). Each nested level adds this much + a VS Code-style guide line.
export const INDENT = 24;

// Single font size for every tree row (name + value), shared by the requester and approver
// trees so a node renders identically on both surfaces. (The old drift came from one tree
// using a <button> — browser-default font — and the other a page-font-inheriting <span>.)
export const ZK_ROW_FONT = 13;

export const ACTION_COLOR: Record<ZkChangeAction, string> = {
  CREATE: '#16a34a',
  SET: '#2563eb',
  CLEAR: '#d97706',
  DELETE: '#dc2626',
};

// Faint per-action row tint, so a change's type reads at a glance in the tree.
export const ROW_TINT: Record<ZkChangeAction, string> = {
  CREATE: '#f0fdf4',
  SET: 'var(--primary-light)',
  CLEAR: '#fffbeb',
  DELETE: '#fef2f2',
};
