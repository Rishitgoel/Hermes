/**
 * The catalogue of every notification Hermes can send, and which delivery
 * channels each one actually uses.
 *
 * This is the single source of truth for the Settings switchboard: the API
 * serves this list straight to the frontend, so labels, grouping and channel
 * support never drift between the two. `notification.service.ts` references the
 * keys as string literals, so the `NotificationScenario` union is what stops a
 * typo from silently creating an ungovernable notification.
 *
 * A note on `channels`: `true` means the scenario really does deliver on that
 * channel today, so the UI renders a switch. `false` means it never has — the UI
 * shows an inert "n/a" cell rather than a switch that would do nothing. In-app
 * notifications are deliberately absent: they are the durable record (and the
 * SSE feed the bell icon reads), so they are always on and never configurable.
 *
 * `SCENARIOS` and `APOLLO_SCENARIOS` are kept separate on purpose. Apollo login
 * provisioning exists only in the admin-panel deployment, so the controller
 * decides whether to append it; keeping the split here means this file is
 * identical in both repos.
 */

export type NotificationChannel = 'email' | 'slack';

export type NotificationCategory =
  | 'access_requests'
  | 'access_lifecycle'
  | 'user_onboarding'
  | 'zookeeper'
  | 'secret_ingestion'
  | 'apollo';

export type NotificationScenario =
  // Access requests
  | 'access.request.created'
  | 'access.request.created.bulk'
  | 'access.request.approved'
  | 'access.request.rejected'
  // Access lifecycle
  | 'access.revoked'
  | 'access.expired'
  | 'access.expiring_soon'
  | 'access.expiry_failed'
  | 'access.queued_for_setup'
  // User onboarding
  | 'user.creation.submitted'
  | 'user.creation.approved'
  | 'user.creation.rejected'
  | 'user.creation.completed'
  // ZooKeeper
  | 'zk.change_request.created'
  | 'zk.change_request.reviewed'
  // Secret ingestion
  | 'secrets.ingestion.submitted'
  | 'secrets.ingestion.reviewed'
  // Apollo (admin-panel deployment only)
  | 'apollo.credentials.issued'
  | 'apollo.credentials.resent';

export interface NotificationScenarioDef {
  key: NotificationScenario;
  category: NotificationCategory;
  label: string;
  description: string;
  /** Who receives it — drives the "Admin-facing" / "You-facing" badge. */
  audience: 'admin' | 'user';
  /**
   * Carries something the recipient cannot obtain any other way (a one-time
   * password, a setup link). Turning such a channel off strands the user unless
   * an admin hands the credential over manually, so the UI warns loudly.
   */
  credentialBearing?: boolean;
  /** Whether this scenario delivers on each channel at all. */
  channels: Record<NotificationChannel, boolean>;
}

export interface NotificationCategoryDef {
  key: NotificationCategory;
  label: string;
  description: string;
}

export const CATEGORIES: NotificationCategoryDef[] = [
  {
    key: 'access_requests',
    label: 'Access Requests',
    description: 'Someone asks for access to a group, and the review outcome.',
  },
  {
    key: 'access_lifecycle',
    label: 'Access Lifecycle',
    description:
      'What happens to access after it is granted — expiry, revocation, warnings.',
  },
  {
    key: 'user_onboarding',
    label: 'Platform Accounts',
    description:
      'Requests for an account on a downstream platform, and the onboarding handover.',
  },
  {
    key: 'zookeeper',
    label: 'ZooKeeper',
    description: 'Proposed znode config changes and their review outcome.',
  },
  {
    key: 'secret_ingestion',
    label: 'Secret Ingestion',
    description: 'Proposed secret key additions and their review outcome.',
  },
  {
    key: 'apollo',
    label: 'Apollo Logins',
    description:
      'Temporary passwords for the Keycloak account that lets staff sign in at all.',
  },
];

/** Every scenario present in both deployments. */
export const SCENARIOS: NotificationScenarioDef[] = [
  // ── Access requests ───────────────────────────────────────────────────────
  {
    key: 'access.request.created',
    category: 'access_requests',
    label: 'Access request submitted',
    description:
      'Tells the group and platform admins that someone is waiting on a review.',
    audience: 'admin',
    channels: { email: true, slack: true },
  },
  {
    key: 'access.request.created.bulk',
    category: 'access_requests',
    label: 'Access requests submitted (bulk)',
    description:
      'One summary per admin when someone requests several groups at once, instead of one message per group.',
    audience: 'admin',
    channels: { email: true, slack: true },
  },
  {
    key: 'access.request.approved',
    category: 'access_requests',
    label: 'Access request approved',
    description: 'Tells the requester their access was granted.',
    audience: 'user',
    channels: { email: true, slack: true },
  },
  {
    key: 'access.request.rejected',
    category: 'access_requests',
    label: 'Access request declined',
    description:
      'Tells the requester their request was turned down, with the reviewer’s reason.',
    audience: 'user',
    channels: { email: true, slack: true },
  },

  // ── Access lifecycle ──────────────────────────────────────────────────────
  {
    key: 'access.revoked',
    category: 'access_lifecycle',
    label: 'Access revoked',
    description: 'Tells someone an admin removed their access.',
    audience: 'user',
    channels: { email: true, slack: true },
  },
  {
    key: 'access.expired',
    category: 'access_lifecycle',
    label: 'Access expired',
    description: 'Tells someone their time-boxed access has lapsed.',
    audience: 'user',
    channels: { email: true, slack: true },
  },
  {
    key: 'access.expiring_soon',
    category: 'access_lifecycle',
    label: 'Access expiring soon',
    description:
      'Advance warning a few days before time-boxed access lapses, so it can be renewed.',
    audience: 'user',
    channels: { email: true, slack: true },
  },
  {
    key: 'access.expiry_failed',
    category: 'access_lifecycle',
    label: 'Auto-expiry failed',
    description:
      'Alerts super and platform admins that Hermes could not revoke expired access after retrying. In-app only.',
    audience: 'admin',
    channels: { email: false, slack: false },
  },
  {
    key: 'access.queued_for_setup',
    category: 'access_lifecycle',
    label: 'Access queued for setup',
    description:
      'Tells the requester their approved access is waiting on a platform account being created.',
    audience: 'user',
    channels: { email: true, slack: true },
  },

  // ── Platform accounts ─────────────────────────────────────────────────────
  {
    key: 'user.creation.submitted',
    category: 'user_onboarding',
    label: 'Account request submitted',
    description:
      'Tells admins that someone needs an account created on a platform.',
    audience: 'admin',
    channels: { email: true, slack: true },
  },
  {
    key: 'user.creation.approved',
    category: 'user_onboarding',
    label: 'Account request approved',
    description: 'Tells the requester their account request was accepted.',
    audience: 'user',
    channels: { email: true, slack: true },
  },
  {
    key: 'user.creation.rejected',
    category: 'user_onboarding',
    label: 'Account request declined',
    description: 'Tells the requester their account request was turned down.',
    audience: 'user',
    channels: { email: true, slack: true },
  },
  {
    key: 'user.creation.completed',
    category: 'user_onboarding',
    label: 'Account ready — onboarding handover',
    description:
      'The platform-specific welcome: AWS password-setup link, the one-time ZooKeeper credential, Redash and Secret Ingestion sign-in details.',
    audience: 'user',
    credentialBearing: true,
    channels: { email: true, slack: true },
  },

  // ── ZooKeeper ─────────────────────────────────────────────────────────────
  {
    key: 'zk.change_request.created',
    category: 'zookeeper',
    label: 'Config change proposed',
    description:
      'Tells the group and ZooKeeper admins that znode changes are waiting on review.',
    audience: 'admin',
    channels: { email: true, slack: true },
  },
  {
    key: 'zk.change_request.reviewed',
    category: 'zookeeper',
    label: 'Config change reviewed',
    description:
      'Tells the proposer whether their changes were applied, partially applied, failed, or rejected.',
    audience: 'user',
    channels: { email: true, slack: true },
  },

  // ── Secret ingestion ──────────────────────────────────────────────────────
  {
    key: 'secrets.ingestion.submitted',
    category: 'secret_ingestion',
    label: 'Secret ingestion requested',
    description:
      'Tells the group and platform admins that new secret keys are waiting on review.',
    audience: 'admin',
    channels: { email: true, slack: true },
  },
  {
    key: 'secrets.ingestion.reviewed',
    category: 'secret_ingestion',
    label: 'Secret ingestion reviewed',
    description:
      'Tells the requester the outcome of their secret ingestion request.',
    audience: 'user',
    channels: { email: true, slack: true },
  },
];

/**
 * Apollo login provisioning — present only where Hermes issues the Keycloak
 * account used to sign in to the admin panel. Appended to the catalogue by the
 * controller in that deployment.
 */
export const APOLLO_SCENARIOS: NotificationScenarioDef[] = [
  {
    key: 'apollo.credentials.issued',
    category: 'apollo',
    label: 'New login — temporary password',
    description:
      'DMs a newly created staff member the random password they need for their first sign-in.',
    audience: 'user',
    credentialBearing: true,
    channels: { email: false, slack: true },
  },
  {
    key: 'apollo.credentials.resent',
    category: 'apollo',
    label: 'Temporary password re-sent',
    description:
      'DMs a freshly minted password when someone lost theirs or never received it.',
    audience: 'user',
    credentialBearing: true,
    channels: { email: false, slack: true },
  },
];

const ALL_SCENARIOS: NotificationScenarioDef[] = [
  ...SCENARIOS,
  ...APOLLO_SCENARIOS,
];

/** Every valid scenario key, including Apollo — used by request validation. */
export const ALL_SCENARIO_KEYS: string[] = ALL_SCENARIOS.map(s => s.key);

const BY_KEY = new Map<string, NotificationScenarioDef>(
  ALL_SCENARIOS.map(s => [s.key, s]),
);

export function getScenario(key: string): NotificationScenarioDef | undefined {
  return BY_KEY.get(key);
}

/**
 * Whether a scenario delivers on a channel at all. A write against an
 * unsupported pair is a client bug, not a preference — the API rejects it
 * rather than storing a row that could never take effect.
 */
export function supportsChannel(
  key: string,
  channel: NotificationChannel,
): boolean {
  return BY_KEY.get(key)?.channels[channel] ?? false;
}
