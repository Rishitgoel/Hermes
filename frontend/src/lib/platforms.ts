// Single source of truth for platform *presentation* (name, description, icon,
// colour) used across the UI — Groups grid, group detail, account-status panel.
//
// Whether a platform is live (ACTIVE) vs COMING_SOON is NOT stored here: it's
// derived from the backend provisioning registry via GET /api/platforms
// (see services/api/platforms.ts). Registering a new adapter on the backend flips
// its card to ACTIVE with no change to this file. Entries below that aren't yet
// registered simply render as "Coming Soon".

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
];

/** Friendly display name for a platform id (falls back to a capitalized id). */
export function platformDisplayName(id: string): string {
  const meta = PLATFORMS.find((p) => p.id === id);
  if (meta) return meta.name;
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Platform';
}
