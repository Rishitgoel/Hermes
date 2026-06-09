// Single source of truth for platform display metadata used across the UI
// (Groups grid, group detail, account-status panel). Adding/flipping a platform
// here updates every surface at once instead of editing several files in lockstep.
//
// NOTE: `status` (ACTIVE vs COMING_SOON) is still hardcoded here. The deeper fix is a
// backend endpoint that derives it from the provisioning registry; until then this
// module is at least the single place to change it.

export interface PlatformMetadata {
  id: string;
  name: string;
  fullName: string;
  description: string;
  iconName: string;
  color: string;
  status: 'ACTIVE' | 'COMING_SOON';
}

export const PLATFORMS: PlatformMetadata[] = [
  {
    id: 'redash',
    name: 'Redash',
    fullName: 'Redash Analytics Platform',
    description: 'Data querying, dashboards, database visualization, and schema access management.',
    iconName: 'Database',
    color: '#E0402C',
    status: 'ACTIVE',
  },
  {
    id: 'aws',
    name: 'AWS',
    fullName: 'Amazon Web Services',
    description: 'IAM Identity Center groups, SSO access, and permission-set memberships.',
    iconName: 'Cloud',
    color: '#FF9900',
    status: 'ACTIVE',
  },
  {
    id: 'jira',
    name: 'Jira',
    fullName: 'Jira Software',
    description: 'Project tracking, issue management, and board administrator credentials.',
    iconName: 'Trello',
    color: '#0052CC',
    status: 'COMING_SOON',
  },
  {
    id: 'grafana',
    name: 'Grafana',
    fullName: 'Grafana Dashboards',
    description: 'Metrics monitoring, alert channels, and log visualization permissions.',
    iconName: 'Activity',
    color: '#FADE2A',
    status: 'COMING_SOON',
  },
  {
    id: 'azure',
    name: 'Azure',
    fullName: 'Microsoft Azure Cloud',
    description: 'Subscription management, active directory controls, and cloud resources.',
    iconName: 'Server',
    color: '#0078D4',
    status: 'COMING_SOON',
  },
  {
    id: 'github',
    name: 'GitHub',
    fullName: 'GitHub Repositories',
    description: 'Source code repositories, organization roles, and branch protection bypasses.',
    iconName: 'Github',
    color: '#24292E',
    status: 'COMING_SOON',
  },
  {
    id: 'gcp',
    name: 'GCP',
    fullName: 'Google Cloud Platform',
    description: 'GCP projects, service accounts, and BigQuery database roles.',
    iconName: 'Globe',
    color: '#4285F4',
    status: 'COMING_SOON',
  },
  {
    id: 'apollo',
    name: 'Apollo',
    fullName: 'Apollo GraphQL Studio',
    description: 'GraphQL schemas, federated graphs, and schema registry write access.',
    iconName: 'Radio',
    color: '#112340',
    status: 'COMING_SOON',
  },
];

/** Friendly display name for a platform id (falls back to a capitalized id). */
export function platformDisplayName(id: string): string {
  const meta = PLATFORMS.find((p) => p.id === id);
  if (meta) return meta.name;
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Platform';
}
