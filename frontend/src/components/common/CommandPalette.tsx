import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import apiClient from '../../services/apiClient';
import { useAuth } from '../../contexts/AuthContext';
import { queryKeys } from '../../lib/queryKeys';

interface PaletteItem {
  key: string;
  label: string;
  hint: 'Page' | 'Group';
  path: string;
  icon: React.ReactNode;
}

interface GroupRow {
  id: string;
  name: string;
  slug: string;
  platform: string;
}

/** Subsequence fuzzy score: prefix > substring > subsequence > no match (null). */
function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t.startsWith(q)) return 3;
  if (t.includes(q)) return 2;
  let ti = 0;
  for (const ch of q) {
    ti = t.indexOf(ch, ti);
    if (ti === -1) return null;
    ti += 1;
  }
  return 1;
}

/**
 * Ctrl/Cmd+K command palette: fuzzy-jump to pages (role-filtered, same
 * predicates as the App.tsx route guards) and groups (from the shared
 * groups query cache).
 */
export const CommandPalette: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global shortcut — Ctrl/Cmd+K toggles, Escape closes.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((cur) => !cur);
        setQuery('');
        setActiveIndex(0);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Groups share the cache the Groups/Dashboard pages already populate.
  const groupsQuery = useQuery<GroupRow[]>({
    queryKey: queryKeys.groups(),
    queryFn: () => apiClient.get('/api/groups').then((r) => r.data),
    enabled: open,
  });

  const items = useMemo<PaletteItem[]>(() => {
    const scopes = user?.adminScopes;
    const roles = user?.roles ?? [];
    const isSuper = (scopes?.superAdmin ?? false) || roles.includes('hermes_super_admin');
    const isPlatformAdmin = (scopes?.platforms?.length ?? 0) > 0;
    const isGroupAdmin = (scopes?.groups?.length ?? 0) > 0;

    const pages: PaletteItem[] = [
      { key: 'page:/', label: 'Dashboard', hint: 'Page', path: '/hermes', icon: <Icons.LayoutDashboard size={16} /> },
      { key: 'page:/groups', label: 'Groups', hint: 'Page', path: '/hermes/groups', icon: <Icons.Layers size={16} /> },
      { key: 'page:/my-requests', label: 'My Requests', hint: 'Page', path: '/hermes/my-requests', icon: <Icons.FileClock size={16} /> },
    ];
    if (isSuper || isPlatformAdmin || isGroupAdmin) {
      pages.push({ key: 'page:/pending-approvals', label: 'Pending Approvals', hint: 'Page', path: '/hermes/pending-approvals', icon: <Icons.CheckSquare size={16} /> });
    }
    if (isSuper || isPlatformAdmin) {
      pages.push({ key: 'page:/admin', label: 'Admin Management', hint: 'Page', path: '/hermes/admin', icon: <Icons.ShieldCheck size={16} /> });
    }
    if (isSuper) {
      pages.push({ key: 'page:/audit-log', label: 'Audit Log', hint: 'Page', path: '/hermes/audit-log', icon: <Icons.History size={16} /> });
    }

    const groups: PaletteItem[] = (groupsQuery.data ?? []).map((g) => ({
      key: `group:${g.id}`,
      label: g.name,
      hint: 'Group',
      path: `/hermes/groups/${g.slug}`,
      icon: <Icons.Database size={16} />,
    }));

    return [...pages, ...groups];
  }, [user, groupsQuery.data]);

  const results = useMemo(() => {
    const scored = items
      .map((item) => ({ item, score: fuzzyScore(query.trim(), item.label) }))
      .filter((r): r is { item: PaletteItem; score: number } => r.score !== null);
    scored.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
    return scored.map((r) => r.item).slice(0, 10);
  }, [items, query]);

  // Keep the highlight inside the result list as it shrinks.
  useEffect(() => {
    if (activeIndex >= results.length) setActiveIndex(0);
  }, [results.length, activeIndex]);

  if (!open) return null;

  const select = (item: PaletteItem) => {
    setOpen(false);
    navigate(item.path);
  };

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[activeIndex]) {
      e.preventDefault();
      select(results[activeIndex]);
    }
  };

  return (
    <div className="command-overlay" onClick={() => setOpen(false)}>
      <div className="command-panel" role="dialog" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <div className="command-input-row">
          <Icons.Search size={18} />
          <input
            ref={inputRef}
            className="command-input"
            type="text"
            placeholder="Jump to a page or group…"
            aria-label="Command palette"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onInputKeyDown}
          />
          <span className="command-esc-hint">esc</span>
        </div>
        <div className="command-list" role="listbox">
          {results.length === 0 ? (
            <div className="command-empty">No matches.</div>
          ) : (
            results.map((item, i) => (
              <button
                key={item.key}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                className={`command-item${i === activeIndex ? ' active' : ''}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => select(item)}
              >
                {item.icon}
                <span className="command-item-label">{item.label}</span>
                <span className="command-item-hint">{item.hint}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
