import type { ZkChangeAction } from '../../services/api/zookeeperApi';

/**
 * Shared ZooKeeper directory-view formatting — used by both the user's config tree
 * (ZookeeperConfig) and the admin's change-review tree (ZkChangeApprovals) so the two
 * surfaces stay visually identical (colors, value typing, indentation).
 */

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

// ── Value typing ────────────────────────────────────────────────────────────────────
// ZooKeeper stores raw bytes, so every value is a string on the wire. The UI infers a
// type for display/editing only — JSON objects/arrays, numbers, booleans, else string.
export type ValueType = 'json' | 'array' | 'number' | 'boolean' | 'string' | 'empty';

export const TYPE_META: Record<ValueType, { label: string; color: string }> = {
  json: { label: 'json', color: '#7c3aed' },
  array: { label: 'array', color: '#0891b2' },
  number: { label: 'num', color: '#2563eb' },
  boolean: { label: 'bool', color: '#d97706' },
  string: { label: 'str', color: 'var(--text-light)' },
  empty: { label: '', color: 'var(--text-light)' },
};

export const detectType = (raw: string | null): ValueType => {
  if (raw == null || raw === '') return 'empty';
  const t = raw.trim();
  // Type by JSON semantics: parse the whole value and read its JSON type. This means
  // a string must be quoted ("foo") to register as `string`; an unquoted token like
  // `123` / `true` is a number / boolean. Anything that isn't valid JSON (bare,
  // unquoted text) falls back to `string` since ZooKeeper stores it verbatim anyway.
  try {
    const v = JSON.parse(t);
    if (Array.isArray(v)) return 'array';
    if (v === null) return 'string';
    switch (typeof v) {
      case 'object':
        return 'json';
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'string':
        return 'string';
    }
  } catch {
    // not valid JSON → treat as a raw (unquoted) string
  }
  return 'string';
};

// Hard cap for single-line previews. A large minified JSON is one unbreakable token —
// without a cap it blows out the row layout, and CSS ellipsis alone still leaves a huge
// string in the DOM. The full value is surfaced via tooltipValue() on hover instead.
const PREVIEW_MAX_CHARS = 160;

/** Compact single-line preview (JSON minified, length-capped) for the read view. */
export const previewValue = (raw: string | null): string => {
  if (raw == null) return '';
  const ty = detectType(raw);
  let out = raw;
  if (ty === 'json' || ty === 'array') {
    try {
      out = JSON.stringify(JSON.parse(raw));
    } catch {
      /* not valid JSON after all — preview verbatim */
    }
  }
  return out.length > PREVIEW_MAX_CHARS ? `${out.slice(0, PREVIEW_MAX_CHARS)}…` : out;
};

/**
 * Hover tooltip for a value preview: pretty-printed JSON (readable, unlike the minified
 * preview), capped so a megabyte value can't produce an absurd tooltip. undefined for
 * empty values so no empty tooltip flashes.
 */
export const tooltipValue = (raw: string | null): string | undefined => {
  if (raw == null || raw === '') return undefined;
  const ty = detectType(raw);
  let out = raw;
  if (ty === 'json' || ty === 'array') {
    try {
      out = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      /* not valid JSON after all — show verbatim */
    }
  }
  return out.length > 2000 ? `${out.slice(0, 2000)}…` : out;
};

export const parsesAsJson = (s: string): boolean => {
  const t = s.trim();
  if (!/^[[{]/.test(t)) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
};
