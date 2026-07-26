import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueries } from '@tanstack/react-query';
import * as Icons from 'lucide-react';
import apiClient from '../../services/apiClient';
import { useAuth } from '../../contexts/AuthContext';
import { queryKeys } from '../../lib/queryKeys';
import { toggleTheme, getTheme } from '../../lib/theme';
import { searchUsers, type AdminUser } from '../../services/api/admin';
import { getZkScope, type ZkScopeEntry } from '../../services/api/zookeeperApi';
import { getSecretScope, type SecretScopeEntry } from '../../services/api/secretsApi';
import { fetchPlatforms, type LivePlatform } from '../../services/api/platforms';

/** Dispatched by the TopBar's search trigger so mouse users can open the palette too. */
export const OPEN_COMMAND_PALETTE_EVENT = 'hermes:open-command-palette';

const RECENT_STORAGE_KEY = 'hermes_palette_recent';
const RECENT_LIMIT = 5;

type Hint = 'Action' | 'Page' | 'Group' | 'Person' | 'Secret' | 'ZooKeeper';

interface PaletteItem {
  key: string;
  label: string;
  sublabel?: string;
  hint: Hint;
  icon: React.ReactNode;
  /** Extra text (beyond the label) that a query can match against, e.g. action keywords. */
  keywords?: string;
  run: () => void;
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

/** Best score for an item across its label and (optional) keywords/sublabel. */
function scoreItem(query: string, item: PaletteItem): number | null {
  const candidates = [item.label, item.keywords, item.sublabel].filter(Boolean) as string[];
  let best: number | null = null;
  for (const c of candidates) {
    const s = fuzzyScore(query, c);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
}

/** Highlights the first matched substring of `text` against the current query. */
const Highlight: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="command-highlight">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
};

function loadRecentKeys(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveRecentKeys(keys: string[]): void {
  localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(keys.slice(0, RECENT_LIMIT)));
}

/** Small debounce so the people-search query doesn't fire on every keystroke. */
function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/**
 * Ctrl/Cmd+K command palette. Searches pages (role-filtered, same predicates as
 * the App.tsx route guards), groups (shared groups query cache), admin-visible
 * people (server-searched, jumps to their User Access record), and runs a
 * couple of global actions (theme, logout). Remembers recently-visited pages/
 * groups so the empty-query view is a quick-nav shortlist, not a cold search box.
 */
export const CommandPalette: React.FC = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentKeys, setRecentKeys] = useState<string[]>(() => loadRecentKeys());
  const inputRef = useRef<HTMLInputElement>(null);

  const openPalette = () => {
    setOpen(true);
    setQuery('');
    setActiveIndex(0);
  };

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

  // Mouse-accessible entry point — the TopBar's search bar dispatches this so
  // the palette isn't keyboard-only (Ctrl+K has no discoverable click path otherwise).
  useEffect(() => {
    const onOpenEvent = () => openPalette();
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenEvent);
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenEvent);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const debouncedQuery = useDebounced(query.trim(), 250);

  const scopes = user?.adminScopes;
  const roles = user?.roles ?? [];
  const isSuper = (scopes?.superAdmin ?? false) || roles.includes('hermes_super_admin');
  const isPlatformAdmin = (scopes?.platforms?.length ?? 0) > 0;
  const isGroupAdmin = (scopes?.groups?.length ?? 0) > 0;
  // People search hits the same admin.controller endpoint UserAccessModal uses — it's
  // gated server-side to admins with at least one manageable platform (super/platform).
  const canSearchPeople = isSuper || isPlatformAdmin;

  // Groups share the cache the Groups/Dashboard pages already populate.
  const groupsQuery = useQuery<GroupRow[]>({
    queryKey: queryKeys.groups(),
    queryFn: () => apiClient.get('/api/groups').then((r) => r.data),
    enabled: open,
  });

  const peopleQuery = useQuery<AdminUser[]>({
    queryKey: queryKeys.adminUsers(debouncedQuery),
    queryFn: () => searchUsers(debouncedQuery),
    enabled: open && canSearchPeople && debouncedQuery.length > 0,
  });

  const platformsQuery = useQuery<LivePlatform[]>({
    queryKey: queryKeys.platforms(),
    queryFn: fetchPlatforms,
    enabled: open && !!user?.hasSecretsAccess,
  });

  const secretsPlatforms = useMemo(() => {
    if (!platformsQuery.data) return [];
    return platformsQuery.data.filter((p) => p.family === 'secrets').map((p) => p.key);
  }, [platformsQuery.data]);

  const secretsScopeQueries = useQueries({
    queries: secretsPlatforms.map((platform) => ({
      queryKey: queryKeys.secretsScope(platform),
      queryFn: () => getSecretScope(platform),
      enabled: open && !!user?.hasSecretsAccess,
    })),
  });

  const secretsScopeData = useMemo(() => {
    const list: { platform: string; entry: SecretScopeEntry }[] = [];
    secretsScopeQueries.forEach((res, idx) => {
      const platform = secretsPlatforms[idx];
      if (res.data) {
        for (const entry of res.data) {
          list.push({ platform, entry });
        }
      }
    });
    return list;
  }, [secretsScopeQueries, secretsPlatforms]);

  const zkScopeQuery = useQuery<ZkScopeEntry[]>({
    queryKey: queryKeys.zkScope(),
    queryFn: getZkScope,
    enabled: open && !!user?.hasZookeeperAccess,
  });

  const rememberVisit = (key: string) => {
    setRecentKeys((prev) => {
      const next = [key, ...prev.filter((k) => k !== key)].slice(0, RECENT_LIMIT);
      saveRecentKeys(next);
      return next;
    });
  };

  // Pages + groups + actions — the stable, always-available item set (people are
  // fetched separately below since they depend on the live query text).
  const items = useMemo<PaletteItem[]>(() => {
    const pages: PaletteItem[] = [
      { key: 'page:/', label: 'Dashboard', hint: 'Page', icon: <Icons.LayoutDashboard size={16} />, run: () => navigate('/hermes') },
      { key: 'page:/groups', label: 'Groups', hint: 'Page', icon: <Icons.Layers size={16} />, run: () => navigate('/hermes/groups') },
      { key: 'page:/my-requests', label: 'My Requests', hint: 'Page', icon: <Icons.FileClock size={16} />, run: () => navigate('/hermes/my-requests') },
    ];
    if (user?.hasZookeeperAccess) {
      pages.push({ key: 'page:/zookeeper', label: 'ZooKeeper Config', hint: 'Page', icon: <Icons.Network size={16} />, run: () => navigate('/hermes/zookeeper') });
    }
    if (user?.hasSecretsAccess) {
      pages.push({ key: 'page:/secrets', label: 'Secret Ingestion', hint: 'Page', icon: <Icons.KeyRound size={16} />, run: () => navigate('/hermes/secrets') });
    }

    if (isSuper || isPlatformAdmin || isGroupAdmin) {
      pages.push({ key: 'page:/pending-approvals', label: 'Pending Approvals', hint: 'Page', icon: <Icons.CheckSquare size={16} />, run: () => navigate('/hermes/pending-approvals') });
    }
    if (isSuper || isPlatformAdmin) {
      pages.push({ key: 'page:/admin', label: 'Admin Management', hint: 'Page', icon: <Icons.ShieldCheck size={16} />, run: () => navigate('/hermes/admin') });
    }
    if (isSuper) {
      pages.push({ key: 'page:/audit-log', label: 'Audit Log', hint: 'Page', icon: <Icons.History size={16} />, run: () => navigate('/hermes/audit-log') });
      pages.push({ key: 'page:/settings', label: 'Settings', hint: 'Page', icon: <Icons.Settings size={16} />, run: () => navigate('/hermes/settings') });
      pages.push({ key: 'page:/settings-notifications', label: 'Notification settings', hint: 'Page', icon: <Icons.Bell size={16} />, run: () => navigate('/hermes/settings') });
      pages.push({ key: 'page:/settings-onboarding', label: 'Onboard a new user', hint: 'Page', icon: <Icons.UserPlus size={16} />, run: () => navigate('/hermes/settings?tab=onboarding') });
    }

    const groups: PaletteItem[] = (groupsQuery.data ?? []).map((g) => ({
      key: `group:${g.id}`,
      label: g.name,
      sublabel: g.platform,
      hint: 'Group',
      icon: <Icons.Database size={16} />,
      run: () => navigate(`/hermes/groups/${g.slug}`),
    }));

    const zkPaths: PaletteItem[] = [];
    if (user?.hasZookeeperAccess && zkScopeQuery.data) {
      for (const entry of zkScopeQuery.data) {
        for (const p of entry.paths) {
          zkPaths.push({
            key: `zookeeper:${entry.groupId}:${p.path}`,
            label: p.path,
            sublabel: `ZooKeeper Config · ${entry.groupName} Group`,
            hint: 'ZooKeeper',
            icon: <Icons.Network size={16} />,
            run: () => navigate(`/hermes/zookeeper?path=${encodeURIComponent(p.path)}`),
          });
        }
      }
    }

    const secrets: PaletteItem[] = [];
    if (user?.hasSecretsAccess && secretsScopeData) {
      const getPlatformLabel = (platformKey: string) => {
        const found = platformsQuery.data?.find((p) => p.key === platformKey);
        if (!found) return platformKey === 'secrets' ? 'Prod' : platformKey;
        return found.label || found.displayName;
      };
      for (const { platform, entry } of secretsScopeData) {
        for (const name of entry.secretNames) {
          const label = getPlatformLabel(platform);
          secrets.push({
            key: `secret:${platform}:${entry.groupId}:${name}`,
            label: name,
            sublabel: `Secret Ingestion (${label}) · ${entry.groupName} Group`,
            hint: 'Secret',
            icon: <Icons.KeyRound size={16} />,
            run: () => navigate(`/hermes/secrets?secret=${encodeURIComponent(name)}&platform=${platform}`),
          });
        }
      }
    }

    const currentlyDark = getTheme() === 'dark';
    const actions: PaletteItem[] = [
      {
        key: 'action:theme',
        label: currentlyDark ? 'Switch to light mode' : 'Switch to dark mode',
        keywords: 'theme dark light appearance',
        hint: 'Action',
        icon: currentlyDark ? <Icons.Sun size={16} /> : <Icons.Moon size={16} />,
        run: () => toggleTheme(),
      },
      {
        key: 'action:logout',
        label: 'Log out',
        keywords: 'sign out logout',
        hint: 'Action',
        icon: <Icons.LogOut size={16} />,
        run: () => logout(),
      },
    ];

    return [...pages, ...groups, ...actions, ...zkPaths, ...secrets];
  }, [
    navigate,
    logout,
    isSuper,
    isPlatformAdmin,
    isGroupAdmin,
    groupsQuery.data,
    user?.hasZookeeperAccess,
    user?.hasSecretsAccess,
    zkScopeQuery.data,
    secretsScopeData,
    platformsQuery.data,
  ]);

  const people = useMemo<PaletteItem[]>(() => {
    if (!canSearchPeople) return [];
    return (peopleQuery.data ?? []).map((u) => ({
      key: `person:${u.userId}`,
      label: u.userName,
      sublabel: u.userEmail,
      hint: 'Person',
      icon: <Icons.User size={16} />,
      run: () => navigate('/hermes/admin', { state: { openUserAccess: u } }),
    }));
  }, [canSearchPeople, peopleQuery.data, navigate]);

  // Grouped, capped-per-category results so a broad query doesn't bury actions
  // under twenty group matches. Category order is fixed; empty categories are
  // dropped. With no query, it's a quick-nav shortlist: recent visits first,
  // then remaining pages, then actions — groups/people only surface on search.
  const sections = useMemo<{ label: string; items: PaletteItem[] }[]>(() => {
    const q = debouncedQuery;
    if (!q) {
      const recent = recentKeys
        .map((k) => items.find((i) => i.key === k))
        .filter((i): i is PaletteItem => !!i);
      const recentKeySet = new Set(recent.map((i) => i.key));
      const pages = items.filter((i) => i.hint === 'Page' && !recentKeySet.has(i.key));
      const actions = items.filter((i) => i.hint === 'Action');
      const out: { label: string; items: PaletteItem[] }[] = [];
      if (recent.length > 0) out.push({ label: 'Recent', items: recent });
      if (pages.length > 0) out.push({ label: 'Pages', items: pages });
      out.push({ label: 'Actions', items: actions });
      return out;
    }

    const CATEGORY_CAP: Record<Hint, number> = { Action: 5, Page: 5, Group: 6, Person: 6, Secret: 6, ZooKeeper: 6 };
    const byCategory = (hint: Hint, pool: PaletteItem[]) => {
      const scored = pool
        .filter((i) => i.hint === hint)
        .map((item) => ({ item, score: scoreItem(q, item) }))
        .filter((r): r is { item: PaletteItem; score: number } => r.score !== null);
      scored.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
      return scored.slice(0, CATEGORY_CAP[hint]).map((r) => r.item);
    };

    const out: { label: string; items: PaletteItem[] }[] = [];
    const actions = byCategory('Action', items);
    const pages = byCategory('Page', items);
    const groups = byCategory('Group', items);
    const personResults = byCategory('Person', people);
    const secretResults = byCategory('Secret', items);
    const zkResults = byCategory('ZooKeeper', items);
    if (actions.length > 0) out.push({ label: 'Actions', items: actions });
    if (pages.length > 0) out.push({ label: 'Pages', items: pages });
    if (groups.length > 0) out.push({ label: 'Groups', items: groups });
    if (secretResults.length > 0) out.push({ label: 'Secrets', items: secretResults });
    if (zkResults.length > 0) out.push({ label: 'ZooKeeper Paths', items: zkResults });
    if (personResults.length > 0) out.push({ label: 'People', items: personResults });
    return out;
  }, [items, people, debouncedQuery, recentKeys]);

  const results = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  // Keep the highlight inside the result list as it shrinks.
  useEffect(() => {
    if (activeIndex >= results.length) setActiveIndex(0);
  }, [results.length, activeIndex]);

  if (!open) return null;

  const select = (item: PaletteItem) => {
    setOpen(false);
    if (item.hint === 'Page' || item.hint === 'Group' || item.hint === 'Secret' || item.hint === 'ZooKeeper') rememberVisit(item.key);
    item.run();
  };

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (results.length === 0) return;
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
            placeholder="Search pages, groups, people, or run a command…"
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
            <div className="command-empty">
              {debouncedQuery && canSearchPeople && peopleQuery.isFetching ? 'Searching…' : 'No matches.'}
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.label}>
                <div className="command-section-label">{section.label}</div>
                {section.items.map((item) => {
                  const i = results.indexOf(item);
                  return (
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
                      <span className="command-item-text">
                        <span className="command-item-label">
                          <Highlight text={item.label} query={debouncedQuery} />
                        </span>
                        {item.sublabel && (
                          <span className="command-item-sublabel">
                            <Highlight text={item.sublabel} query={debouncedQuery} />
                          </span>
                        )}
                      </span>
                      <span className="command-item-hint">{item.hint}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="command-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
