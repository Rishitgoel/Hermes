/** Shared formatting helpers for the Admin Management components. */

import type { ReconciliationSummary } from '../../services/api/admin';

export const prettyPlatform = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);

/**
 * Build a user-facing toast from a member-reconciliation summary (ZooKeeper path edits),
 * shared by the group Settings tab and the Levels tab so per-member ACL failures are
 * surfaced consistently rather than silently swallowed.
 */
export function reconcileToast(r: ReconciliationSummary | null | undefined): { ok: boolean; message: string } {
  if (!r) return { ok: true, message: 'Saved.' };
  const parts: string[] = [];
  if (r.addedPaths.length) parts.push(`+${r.addedPaths.length} added`);
  if (r.removedPaths.length) parts.push(`−${r.removedPaths.length} removed`);
  if (r.updatedPaths.length) parts.push(`${r.updatedPaths.length} perms updated`);
  const detail = parts.length ? ` (${parts.join(', ')})` : ' (no path changes)';
  if (r.errors.length) {
    return {
      ok: false,
      message: `Saved, but ${r.errors.length} member update(s) failed — see the audit log for manual cleanup.`,
    };
  }
  return { ok: true, message: `Saved — ${r.memberCount} member(s) reconciled${detail}.` };
}

/** Keycloak usernames can carry underscores; render them as spaces. */
export const cleanName = (n: string) => n.replace(/_/g, ' ');

export const slugify = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Curated business-flavoured lucide icons used as a per-group fallback. */
const FALLBACK_GROUP_ICONS = [
  'CreditCard', 'TrendingUp', 'RefreshCw', 'DollarSign', 'HeartHandshake', 'Megaphone',
  'BarChart3', 'ShoppingCart', 'Wallet', 'LineChart', 'Briefcase', 'PieChart',
  'Users', 'Boxes', 'Building2', 'Receipt', 'Gauge', 'Target',
];

/** Stable string hash → non-negative int (same seed always maps to the same icon). */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Resolve the lucide icon name for a group. Uses the group's own `icon` when set
 * (e.g. AWS groups seeded with one); otherwise derives a distinct icon from a
 * curated set keyed on the group's slug — so groups that came in without an icon
 * (e.g. Redash groups auto-created by Platform Sync) don't all collapse to the
 * same default. Deterministic, so a group keeps the same icon across renders.
 */
export function groupIconName(group: { slug?: string; id?: string; name: string; icon?: string | null }): string {
  if (group.icon) return group.icon;
  const seed = group.slug || group.id || group.name;
  return FALLBACK_GROUP_ICONS[hashString(seed) % FALLBACK_GROUP_ICONS.length];
}
