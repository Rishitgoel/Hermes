import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import { queryKeys } from '../../lib/queryKeys';
import { cleanName } from './adminUtils';
import { searchUsers, type AdminUser } from '../../services/api/admin';

/** Small debounce so the user-search query doesn't fire on every keystroke. */
function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/** Dark-mode-safe avatar tints (bg / fg pairs from the design-system status ramps). */
const AVATAR_PALETTE: Array<{ bg: string; fg: string }> = [
  { bg: 'var(--primary-light)', fg: 'var(--primary)' },
  { bg: 'var(--status-approved-bg)', fg: 'var(--status-approved-text)' },
  { bg: 'var(--status-pending-bg)', fg: 'var(--status-pending-text)' },
  { bg: 'var(--status-revoked-bg)', fg: 'var(--status-revoked-text)' },
];

/** Stable hash so a given user always lands on the same avatar color. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function avatarColors(seed: string) {
  return AVATAR_PALETTE[hashString(seed) % AVATAR_PALETTE.length];
}

/** Up to two initials from a (cleaned) display name. */
function initials(name: string): string {
  const parts = cleanName(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Highlights the matched substring of `text` against the current query. */
const Highlight: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: 'var(--primary-light)', color: 'var(--primary)', borderRadius: '3px', padding: '0 1px' }}>
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
};

interface UserPickerProps {
  selected: AdminUser | null;
  onSelect: (u: AdminUser | null) => void;
  /** userIds that already hold the role/membership — rendered disabled. */
  disabledIds?: Set<string>;
  /** Tag shown on disabled rows, e.g. "Already admin" / "Already a member". */
  disabledLabel?: string;
  /** Verb for the empty-state copy: "…before they can be {emptyVerb}." */
  emptyVerb?: string;
  /** Fired on Enter when a user is selected (submit shortcut). */
  onSubmit?: () => void;
  /** Fired on Escape. */
  onCancel?: () => void;
  listMaxHeight?: number;
}

/**
 * Searchable user list shared by AssignAdminModal and AddMemberModal. Owns the
 * search box + debounced query; reports the chosen user up via onSelect. Supports
 * full keyboard control (↑/↓ to move, Enter to submit, Esc to cancel), colored
 * initials avatars, match highlighting, and disabled rows for ineligible users.
 */
export const UserPicker: React.FC<UserPickerProps> = ({
  selected,
  onSelect,
  disabledIds,
  disabledLabel = 'Unavailable',
  emptyVerb = 'selected',
  onSubmit,
  onCancel,
  listMaxHeight = 260,
}) => {
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const debouncedSearch = useDebounced(search, 300);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const usersQuery = useQuery({
    queryKey: queryKeys.adminUsers(debouncedSearch),
    queryFn: () => searchUsers(debouncedSearch),
  });

  const users = usersQuery.data ?? [];
  const isDisabled = (u: AdminUser) => disabledIds?.has(u.userId) ?? false;
  // The backend caps user search at 20 results (searchUsers `take: 20`). When we
  // get exactly that many, more users likely exist but are hidden — prompt the
  // user to narrow with a search term rather than silently truncating.
  const SEARCH_CAP = 20;
  const capped = users.length >= SEARCH_CAP;

  // Keep the highlighted row scrolled into view as it moves.
  useEffect(() => {
    if (activeIndex >= 0) rowRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  /** Move the highlight to the next selectable row in `dir`, skipping disabled ones. */
  const moveActive = (dir: 1 | -1) => {
    if (users.length === 0) return;
    let i = activeIndex < 0 ? (dir === 1 ? -1 : 0) : activeIndex;
    for (let step = 0; step < users.length; step++) {
      i = (i + dir + users.length) % users.length;
      if (!isDisabled(users[i])) {
        setActiveIndex(i);
        onSelect(users[i]);
        return;
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === 'Enter') {
      if (selected) {
        e.preventDefault();
        onSubmit?.();
      }
    } else if (e.key === 'Escape') {
      onCancel?.();
    }
  };

  return (
    <div onKeyDown={handleKeyDown}>
      <div className="form-input-with-icon" style={{ marginBottom: '10px' }}>
        <Icons.Search size={16} />
        <input
          type="text"
          className="form-input"
          placeholder="Search users by name or email…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setActiveIndex(-1);
            onSelect(null);
          }}
          autoFocus
          role="combobox"
          aria-expanded={users.length > 0}
        />
      </div>

      {!usersQuery.isLoading && !usersQuery.isError && users.length > 0 && (
        <div
          style={{
            fontSize: '11px',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--text-light)',
            fontWeight: 600,
            margin: '0 2px 8px',
          }}
        >
          {users.length} {users.length === 1 ? 'user' : 'users'}
          {debouncedSearch ? ' matched' : ''}
          {capped && (
            <span style={{ color: 'var(--text-muted)', textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>
              {' '}· showing first {SEARCH_CAP}, type to refine
            </span>
          )}
        </div>
      )}

      <div style={{ maxHeight: `${listMaxHeight}px`, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {usersQuery.isLoading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '8px' }}>Searching…</div>
        ) : usersQuery.isError ? (
          <div style={{ color: 'var(--status-rejected-text)', fontSize: '13px', padding: '8px' }}>
            {(usersQuery.error as any)?.message || 'Failed to search users.'}
          </div>
        ) : users.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '28px 16px', color: 'var(--text-light)' }}>
            <Icons.Users size={28} style={{ opacity: 0.5, marginBottom: '8px' }} />
            <div style={{ fontSize: '13px', lineHeight: 1.5 }}>
              {debouncedSearch
                ? `No matching users. They must sign in to Hermes once before they can be ${emptyVerb}.`
                : 'No users yet. Users appear here once they have signed in to Hermes.'}
            </div>
          </div>
        ) : (
          users.map((u, i) => {
            const disabled = isDisabled(u);
            const isSel = selected?.userId === u.userId;
            const isActive = i === activeIndex;
            const av = avatarColors(u.userId);
            return (
              <button
                key={u.userId}
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                type="button"
                disabled={disabled}
                aria-selected={isSel}
                onClick={() => {
                  setActiveIndex(i);
                  onSelect(u);
                }}
                onMouseEnter={() => !disabled && setActiveIndex(i)}
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '9px 11px',
                  border: `1px solid ${isSel ? 'var(--primary)' : isActive ? 'var(--border-focus)' : 'var(--border)'}`,
                  background: isSel ? 'var(--primary-light)' : isActive ? 'var(--bg-hover)' : 'var(--bg-card)',
                  borderRadius: 'var(--radius-md)',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.55 : 1,
                  textAlign: 'left',
                  transition: 'none',
                }}
              >
                {isSel && (
                  <span
                    style={{ position: 'absolute', left: 0, top: '8px', bottom: '8px', width: '3px', borderRadius: '0 3px 3px 0', background: 'var(--primary)' }}
                  />
                )}
                <span
                  style={{
                    width: '32px',
                    height: '32px',
                    flexShrink: 0,
                    borderRadius: '50%',
                    background: av.bg,
                    color: av.fg,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '12px',
                    fontWeight: 600,
                  }}
                >
                  {initials(u.userName)}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 500, fontSize: '13px', color: isSel ? 'var(--primary)' : 'var(--text-main)' }}>
                    <Highlight text={cleanName(u.userName)} query={debouncedSearch} />
                  </span>
                  <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <Highlight text={u.userEmail} query={debouncedSearch} />
                  </span>
                </span>
                {disabled ? (
                  <span style={{ fontSize: '11px', color: 'var(--text-light)', fontWeight: 600, flexShrink: 0 }}>{disabledLabel}</span>
                ) : isSel ? (
                  <Icons.Check size={16} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

export default UserPicker;
