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

/** Compact single-line preview (JSON minified) for the read view. */
export const previewValue = (raw: string | null): string => {
  if (raw == null) return '';
  const ty = detectType(raw);
  if (ty === 'json' || ty === 'array') {
    try {
      return JSON.stringify(JSON.parse(raw));
    } catch {
      return raw;
    }
  }
  return raw;
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
