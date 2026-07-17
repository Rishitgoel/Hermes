/**
 * Shared value typing + preview formatting.
 *
 * Originally lived in `components/zookeeper/zkFormat.ts` (ZooKeeper stores raw bytes, so every
 * value is a string on the wire and the UI infers a display type). The exact same problem exists
 * for Secret Ingestion values (an AWS secret value is an opaque string that's often JSON), so the
 * detection/preview logic was lifted here to be reused by both surfaces. `zkFormat.ts` re-exports
 * these so every existing ZooKeeper import keeps working unchanged.
 */

// ── Value typing ────────────────────────────────────────────────────────────────────
// The UI infers a type for display/editing only — JSON objects/arrays, numbers, booleans,
// else string.
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
  // unquoted text) falls back to `string` since the value is stored verbatim anyway.
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
// string in the DOM. The full value is surfaced via the JSON viewer / tooltip instead.
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

// Cap for the full-value JSON viewer. Big enough to show any realistic secret/config value in
// full, but bounded so a pathological megabyte value can't freeze the DOM when expanded.
const PRETTY_MAX_CHARS = 50000;

/**
 * Full, readable rendering of a value for the JSON viewer modal: pretty-printed (2-space) when
 * it parses as JSON/array, verbatim otherwise. Length-capped with a trailing marker.
 */
export const prettyValue = (raw: string | null): string => {
  if (raw == null || raw === '') return '';
  const ty = detectType(raw);
  let out = raw;
  if (ty === 'json' || ty === 'array') {
    try {
      out = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      /* not valid JSON after all — show verbatim */
    }
  }
  return out.length > PRETTY_MAX_CHARS ? `${out.slice(0, PRETTY_MAX_CHARS)}\n… (truncated)` : out;
};

/**
 * Whether a value is "big" enough to warrant the expand-to-viewer affordance rather than just an
 * inline preview: any JSON/array, anything multi-line, or a long single-line string.
 */
export const isLargeValue = (raw: string | null): boolean => {
  if (raw == null || raw === '') return false;
  const ty = detectType(raw);
  if (ty === 'json' || ty === 'array') return true;
  if (raw.includes('\n')) return true;
  return raw.length > 80;
};
