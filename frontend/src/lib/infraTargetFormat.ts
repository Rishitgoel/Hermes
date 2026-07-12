/** Shared between SecretIngestion.tsx (compose screen) and SecretIngestionApprovals.tsx
 * (review queue) so the env badge, PR-state chip, and simulated-path formatting never drift
 * out of sync between the two surfaces — mirrors backend/src/services/infra-repo-sync.service.ts's
 * own `envOf`, which is the source of truth for what env a manifest path resolves to. */

/** Best-effort environment label for a manifest path — MUST stay in sync with the backend's
 * envOf (infra-repo-sync.service.ts) so a path resolves to the same env on both surfaces. */
export const envOf = (path: string): string => {
  const m =
    path.match(/(^|\/)(prod|qa2|qa|uat|local|dev|staging)(\/|$)/i) ||
    path.match(/values-(prod|qa2|qa|uat|local|dev|staging)/i);
  return (m ? m[2] || m[1] : 'root').toLowerCase();
};

/** Env → badge background color. */
export const ENV_BG: Record<string, string> = {
  prod: '#b8384a',
  staging: '#9a6a06',
  uat: '#9a6a06',
  qa: '#2563eb',
  qa2: '#2563eb',
  local: '#6b7280',
  dev: '#6b7280',
};
export const envBg = (env: string): string => ENV_BG[env] || '#6b7280';

/** infraSyncState → badge label + class. */
export const INFRA_STATE_META: Record<string, { label: string; cls: string }> = {
  OPEN: { label: 'PR open', cls: 'badge-pending' },
  MERGED: { label: 'PR merged', cls: 'badge-active' },
  CLOSED: { label: 'PR closed', cls: 'badge-danger' },
  SKIPPED: { label: 'No PR needed', cls: 'badge-warning' },
  FAILED: { label: 'PR failed', cls: 'badge-danger' },
};

/** In simulation the backend prefixes the fake path with "(simulated) "; surface that as a
 *  badge instead of letting it read like part of the filename. */
export const formatTargetPath = (path: string): { display: string; simulated: boolean } => {
  const prefix = '(simulated) ';
  const simulated = path.startsWith(prefix);
  return { display: simulated ? path.slice(prefix.length) : path, simulated };
};
