// Single source of truth for platform *presentation* (name, description, icon,
// colour) used across the UI — Groups grid, group detail, account-status panel.
//
// Whether a platform is live (ACTIVE) vs COMING_SOON is NOT stored here: it's
// derived from the backend provisioning registry via GET /api/platforms
// (see services/api/platforms.ts). Registering a new adapter on the backend flips
// its card to ACTIVE with no change to this file. Entries below that aren't yet
// registered simply render as "Coming Soon".

/**
 * The platform a brand-new user is onboarded to by default (mirrors the backend's
 * DEFAULT_PLATFORM). Used as the fallback when a caller has no specific platform in
 * hand. Single source of truth on the frontend — don't sprinkle the literal around.
 */
export const DEFAULT_PLATFORM = (import.meta.env.VITE_DEFAULT_PLATFORM || 'redash').toLowerCase();

export interface PlatformMetadata {
  id: string;
  name: string;
  fullName: string;
  description: string;
  iconName: string;
  color: string;
}

export const PLATFORMS: PlatformMetadata[] = [
  {
    id: 'redash',
    name: 'Redash',
    fullName: 'Redash Analytics Platform',
    description: 'Data querying, dashboards, database visualization, and schema access management.',
    iconName: 'Database',
    color: '#E0402C',
  },
  {
    id: 'aws',
    name: 'AWS',
    fullName: 'Amazon Web Services',
    description: 'IAM Identity Center groups, SSO access, and permission-set memberships.',
    iconName: 'Cloud',
    color: '#FF9900',
  },
  {
    id: 'jira',
    name: 'Jira',
    fullName: 'Jira Software',
    description: 'Project tracking, issue management, and board administrator credentials.',
    iconName: 'Trello',
    color: '#0052CC',
  },
  {
    id: 'grafana',
    name: 'Grafana',
    fullName: 'Grafana Dashboards',
    description: 'Metrics monitoring, alert channels, and log visualization permissions.',
    iconName: 'Activity',
    color: '#FADE2A',
  },
  {
    id: 'azure',
    name: 'Azure',
    fullName: 'Microsoft Azure Cloud',
    description: 'Subscription management, active directory controls, and cloud resources.',
    iconName: 'Server',
    color: '#0078D4',
  },
  {
    id: 'github',
    name: 'GitHub',
    fullName: 'GitHub Repositories',
    description: 'Source code repositories, organization roles, and branch protection bypasses.',
    iconName: 'Github',
    color: '#24292E',
  },
  {
    id: 'gcp',
    name: 'GCP',
    fullName: 'Google Cloud Platform',
    description: 'GCP projects, service accounts, and BigQuery database roles.',
    iconName: 'Globe',
    color: '#4285F4',
  },
  {
    id: 'apollo',
    name: 'Apollo',
    fullName: 'Apollo GraphQL Studio',
    description: 'GraphQL schemas, federated graphs, and schema registry write access.',
    iconName: 'Radio',
    color: '#112340',
  },
  {
    id: 'zookeeper',
    name: 'ZooKeeper',
    fullName: 'Apache ZooKeeper',
    description: 'Distributed coordination service — per-znode ACL access with read/write permission tiers.',
    iconName: 'Network',
    color: '#326CE5',
  },
  {
    id: 'secrets',
    name: 'Secret Ingestion',
    fullName: 'AWS Secrets Manager Ingestion',
    description: 'Ingest secret key-value pairs into AWS Secrets Manager with approval-gated peer review.',
    iconName: 'KeyRound',
    color: '#DD344C',
  },
];

/**
 * Adapter-owned display names (e.g. "Redash (QA)") keyed by platform instance,
 * populated by fetchPlatforms() whenever GET /api/platforms resolves. Lets
 * platformDisplayName() show a multi-instance platform's real name everywhere
 * — including deep child components (GroupDrawer, AssignAdminModal, etc.) that
 * only ever receive a bare platform key — without threading the live platforms
 * list through every call site. A module-level cache rather than React state
 * since these are plain helper functions called outside any component's render.
 */
const liveDisplayNames: Record<string, string> = {};

export function registerLivePlatforms(platforms: { key: string; displayName: string }[]): void {
  for (const p of platforms) {
    liveDisplayNames[p.key] = p.displayName;
  }
}

/**
 * Friendly display name for a platform id. Prefers the live adapter's own
 * displayName (correct for multi-instance keys like "redash-qa" → "Redash
 * (QA)"); falls back to the static PLATFORMS metadata, then a capitalized id
 * before the live platforms list has loaded.
 */
export function platformDisplayName(id: string): string {
  if (!id) return 'Platform';
  if (liveDisplayNames[id]) return liveDisplayNames[id];
  const meta = PLATFORMS.find((p) => p.id === id);
  if (meta) return meta.name;
  return id.charAt(0).toUpperCase() + id.slice(1);
}
