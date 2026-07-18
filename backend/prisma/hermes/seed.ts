import { PrismaClient } from '@prisma/client';
import config from '../../src/config/config';

const prisma = new PrismaClient();

const initialGroups = [
  {
    platform: 'redash',
    name: 'Growth',
    slug: 'growth',
    description: 'Access to growth analytics dashboards and user acquisition metrics.',
    icon: 'TrendingUp',
    color: '#6B46C1', // Purple
    externalGroupId: '101', // Mock Redash Group ID
    tables: ['growth_analytics', 'conversion_funnels', 'acquisition_channels', 'attribution_models'],
  },
  {
    platform: 'redash',
    name: 'Retention',
    slug: 'retention',
    description: 'Access to customer retention metrics and churn analysis datasets.',
    icon: 'RefreshCw',
    color: '#6B46C1', // Purple
    externalGroupId: '102', // Mock Redash Group ID
    tables: ['churn_predictions', 'user_engagement_logs', 'lifecycle_events', 'reactivation_campaigns'],
  },
  {
    platform: 'redash',
    name: 'Lending',
    slug: 'lending',
    description: 'Access to consumer lending databases and loan risk profiles.',
    icon: 'DollarSign',
    color: '#6B46C1', // Purple
    externalGroupId: '103', // Mock Redash Group ID
    tables: ['loan_applications', 'underwriting_rules', 'risk_profiles', 'emi_schedules', 'disbursals'],
  },
  {
    platform: 'redash',
    name: 'Customer Support',
    slug: 'customer-support',
    description: 'Access to customer experience databases, ticket data, and agent metrics.',
    icon: 'HeartHandshake',
    color: '#6B46C1', // Purple
    externalGroupId: '105', // Mock Redash Group ID
    tables: ['support_tickets', 'agent_performance', 'customer_feedback', 'escalation_logs'],
  },
  {
    platform: 'redash',
    name: 'Credit Card',
    slug: 'credit-card',
    description: 'Access to credit card transactions ledger and billing databases.',
    icon: 'CreditCard',
    color: '#6B46C1', // Purple
    externalGroupId: '104', // Mock Redash Group ID
    tables: ['card_transactions', 'credit_limits', 'rewards_ledger', 'billing_statements'],
  },
  {
    platform: 'redash',
    name: 'Marketing',
    slug: 'marketing',
    description: 'Access to marketing campaign performance, ad spend, and promotion metrics.',
    icon: 'Megaphone',
    color: '#6B46C1', // Purple
    externalGroupId: '106', // Mock Redash Group ID
    tables: ['ad_spend', 'campaign_metrics', 'email_deliverability', 'promo_codes'],
  },

  // ── Redash QA — same mock group space as prod Redash, distinct Hermes groups
  // so the two platform cards each have something to request against. ──
  {
    platform: 'redash-qa',
    name: 'Growth (QA)',
    slug: 'growth-qa',
    description: 'QA-instance access to growth analytics dashboards, for pre-release validation.',
    icon: 'TrendingUp',
    color: '#0EA5E9', // Blue, to visually distinguish QA from prod in the UI
    externalGroupId: '101',
    tables: ['growth_analytics', 'conversion_funnels'],
  },
  {
    platform: 'redash-qa',
    name: 'Credit Card (QA)',
    slug: 'credit-card-qa',
    description: 'QA-instance access to credit card ledger data, for pre-release validation.',
    icon: 'CreditCard',
    color: '#0EA5E9',
    externalGroupId: '104',
    tables: ['card_transactions', 'billing_statements'],
  },

  // ── AWS IAM Identity Center — group ids are unvalidated in simulation, so any
  // string works; distinct from the sim store's own default seeded groups. ──
  {
    platform: 'aws',
    name: 'Platform Engineering',
    slug: 'platform-engineering',
    description: 'AWS IAM access for engineers managing cloud infrastructure and deployments.',
    icon: 'Server',
    color: '#F59E0B', // Amber, AWS-ish
    externalGroupId: 'grp-sim-platform-eng',
    tables: [],
  },
  {
    platform: 'aws',
    name: 'Data Science',
    slug: 'data-science',
    description: 'AWS access for the data science team — SageMaker, S3 data lake, and Athena.',
    icon: 'BarChart3',
    color: '#F59E0B',
    externalGroupId: 'grp-sim-data-science',
    tables: [],
  },

  // ── ZooKeeper — externalGroupId is a newline-separated path#perms list; paths
  // don't need to pre-exist, Hermes creates them on demand. ──
  {
    platform: 'zookeeper',
    name: 'Config Management',
    slug: 'config-management',
    description: 'Read/write access to shared application configuration znodes.',
    icon: 'Settings',
    color: '#10B981', // Green
    externalGroupId: '/hermes/config#cdrw',
    tables: [],
  },
  {
    platform: 'zookeeper',
    name: 'Feature Flags',
    slug: 'feature-flags',
    description: 'Manage feature-flag and experiment rollout state.',
    icon: 'Flag',
    color: '#10B981',
    externalGroupId: '/hermes/feature-flags#cdrw\n/hermes/feature-flags/experiments#r',
    tables: [],
  },

  // ── Secret Ingestion (prod AWS account) — reuses the sim store's own seeded
  // secrets (payment/gateway, payment/webhook) so the ingestion flow has real
  // resolved keys to show, not an empty scope. ──
  {
    platform: 'secrets',
    name: 'Payments Secrets',
    slug: 'payments-secrets',
    description: 'Stage and manage API keys/config for the payments gateway integration.',
    icon: 'KeyRound',
    color: '#EF4444', // Red
    externalGroupId: 'payment*',
    tables: [],
  },

  // ── Secret Ingestion (sandbox AWS account) — reuses the sim store's own
  // seeded sandbox secrets (sandbox/service-a, sandbox/service-b). ──
  {
    platform: 'secrets-sandbox',
    name: 'Sandbox Secrets',
    slug: 'sandbox-secrets',
    description: 'Stage and manage secrets for sandbox/staging services (separate AWS account).',
    icon: 'KeyRound',
    color: '#EF4444',
    externalGroupId: 'sandbox*',
    tables: [],
  },
];

async function main() {
  console.log('Seeding initial Hermes groups...');

  for (const group of initialGroups) {
    const upserted = await prisma.group.upsert({
      where: { slug: group.slug },
      update: {
        name: group.name,
        description: group.description,
        icon: group.icon,
        color: group.color,
        externalGroupId: group.externalGroupId,
        tables: group.tables,
      },
      create: { ...group },
    });
    console.log(`Upserted group: ${upserted.name} (${upserted.slug}) [${upserted.platform}]`);
  }

  // Example permission-levels (subgroups) for Credit Card, demonstrating the
  // feature. Each level is backed by its own Redash group id (see the mock groups
  // in redash.service.ts syncGroups). The other five groups stay level-less and are
  // requested directly, so both modes coexist. Levels are real config (not sim
  // drift), so they seed in live mode too.
  const creditCard = await prisma.group.findUnique({ where: { slug: 'credit-card' } });
  if (creditCard) {
    const creditCardLevels = [
      { name: 'Intern', slug: 'intern', permission: 'read-only', externalGroupId: '1041', rank: 0, description: 'Read-only access to credit card dashboards.' },
      { name: 'Junior Dev', slug: 'junior-dev', permission: 'read-only', externalGroupId: '1042', rank: 1, description: 'Read-only access plus saved-query history.' },
      { name: 'Senior Dev', slug: 'senior-dev', permission: 'write', externalGroupId: '1043', rank: 2, description: 'Full read/write access to credit card data sources.' },
    ];
    for (const lvl of creditCardLevels) {
      await prisma.groupLevel.upsert({
        where: { groupId_slug: { groupId: creditCard.id, slug: lvl.slug } },
        update: { name: lvl.name, permission: lvl.permission, externalGroupId: lvl.externalGroupId, rank: lvl.rank, description: lvl.description },
        create: { groupId: creditCard.id, ...lvl },
      });
    }
    console.log('Seeded Credit Card levels: Intern, Junior Dev, Senior Dev');
  }

  // Sim-only fixtures below: fake admin/member rows that mirror the simulation
  // identities (group-admin-uuid-2222, platform-admin-uuid-4444). They reference
  // non-existent Keycloak users, so seeding them into a LIVE database just creates
  // drift the reconciliation job removes on its next run. Only plant them in
  // simulation mode; in live mode, assign admins through the Admin Management UI.
  if (!config.isSimulation) {
    console.log('Skipping sim admin/access fixtures (live mode) — assign admins via the Admin Management UI.');
    console.log('Seeding completed successfully!');
    return;
  }

  console.log('Seeding default group admin for Growth...');
  const growthGroup = await prisma.group.findUnique({
    where: { slug: 'growth' },
  });
  if (growthGroup) {
    await prisma.groupAdmin.upsert({
      where: {
        groupId_userId: {
          groupId: growthGroup.id,
          userId: 'group-admin-uuid-2222',
        },
      },
      update: {
        userName: 'Yogesh_Verma',
        userEmail: 'yogesh.verma@bachatt.app',
        assignedBy: 'system',
      },
      create: {
        groupId: growthGroup.id,
        userId: 'group-admin-uuid-2222',
        userName: 'Yogesh_Verma',
        userEmail: 'yogesh.verma@bachatt.app',
        assignedBy: 'system',
      },
    });
    console.log('Seeded Growth admin: Yogesh Verma');

    // No composite unique key exists in Prisma anymore — uniqueness for active
    // grants is enforced by a partial DB index. So we find-or-create manually.
    const existingAccess = await prisma.userAccess.findFirst({
      where: {
        userId: 'group-admin-uuid-2222',
        groupId: growthGroup.id,
        isActive: true,
      },
    });
    if (existingAccess) {
      await prisma.userAccess.update({
        where: { id: existingAccess.id },
        data: {
          userName: 'Yogesh_Verma',
          userEmail: 'yogesh.verma@bachatt.app',
          grantedBy: 'system',
        },
      });
    } else {
      await prisma.userAccess.create({
        data: {
          userId: 'group-admin-uuid-2222',
          groupId: growthGroup.id,
          userName: 'Yogesh_Verma',
          userEmail: 'yogesh.verma@bachatt.app',
          isActive: true,
          grantedBy: 'system',
        },
      });
    }
    console.log('Seeded active UserAccess for Growth admin: Yogesh Verma');
  }

  // Seed a Redash platform admin (mirrors the `platform_admin` simulation
  // identity in auth.middleware) so the three-tier model is testable locally.
  console.log('Seeding default platform admin for Redash...');
  await prisma.platformAdmin.upsert({
    where: {
      userId_platform: {
        userId: 'platform-admin-uuid-4444',
        platform: 'redash',
      },
    },
    update: {
      userName: 'Neha_Sharma',
      userEmail: 'neha.sharma@bachatt.app',
      assignedBy: 'system',
    },
    create: {
      userId: 'platform-admin-uuid-4444',
      platform: 'redash',
      userName: 'Neha_Sharma',
      userEmail: 'neha.sharma@bachatt.app',
      assignedBy: 'system',
    },
  });
  console.log('Seeded Redash platform admin: Neha Sharma');

  await seedDemoWorkload();

  console.log('Seeding completed successfully!');
}

// ══════════════════════════════════════════════════════════════════════════
// DEMO WORKLOAD — pending requests, active grants across all four simulated
// identities, extra admin assignments, ZooKeeper/Secret Ingestion requests in
// varied states, and matching audit entries. Purely cosmetic (sim-only,
// called from inside the `config.isSimulation` guard above) — makes a fresh
// deploy look like an org that's actually been using the tool, not an empty
// install. Safe to re-run: every write is an upsert or a guarded find-or-create.
// ══════════════════════════════════════════════════════════════════════════

const USERS = {
  superAdmin: { id: 'super-admin-uuid-1111', name: 'Mayank_Aggarwal', email: 'mayank.aggarwal@bachatt.app' },
  platformAdmin: { id: 'platform-admin-uuid-4444', name: 'Neha_Sharma', email: 'neha.sharma@bachatt.app' },
  groupAdmin: { id: 'group-admin-uuid-2222', name: 'Yogesh_Verma', email: 'yogesh.verma@bachatt.app' },
  user: { id: 'regular-user-uuid-3333', name: 'Rishit_Goel', email: 'rishit.goel@bachatt.app' },
};

async function seedDemoWorkload() {
  console.log('Seeding demo workload (requests, grants, admins, ZK/secrets requests, audit log)...');

  const groupSlugs = [
    'growth', 'retention', 'lending', 'customer-support', 'credit-card', 'marketing',
    'growth-qa', 'credit-card-qa', 'platform-engineering', 'data-science',
    'config-management', 'feature-flags', 'payments-secrets', 'sandbox-secrets',
  ];
  const groups = await prisma.group.findMany({ where: { slug: { in: groupSlugs } } });
  const g = Object.fromEntries(groups.map((x) => [x.slug, x]));

  const creditCardLevels = await prisma.groupLevel.findMany({ where: { groupId: g['credit-card']?.id } });
  const lvl = Object.fromEntries(creditCardLevels.map((x) => [x.slug, x]));

  // ── Extra admin assignments: Neha also admins AWS (multi-platform platform
  // admin), Yogesh also admins two more groups (multi-group group admin). ──
  await prisma.platformAdmin.upsert({
    where: { userId_platform: { userId: USERS.platformAdmin.id, platform: 'aws' } },
    update: { userName: USERS.platformAdmin.name, userEmail: USERS.platformAdmin.email, assignedBy: 'system' },
    create: { userId: USERS.platformAdmin.id, platform: 'aws', userName: USERS.platformAdmin.name, userEmail: USERS.platformAdmin.email, assignedBy: 'system' },
  });
  await auditOnce('PLATFORM_ADMIN_ASSIGNED', 'system', 'System', {
    targetUserId: USERS.platformAdmin.id, targetUserName: USERS.platformAdmin.name,
    details: { platform: 'aws' },
  });

  for (const slug of ['config-management', 'payments-secrets']) {
    if (!g[slug]) {continue;}
    await prisma.groupAdmin.upsert({
      where: { groupId_userId: { groupId: g[slug].id, userId: USERS.groupAdmin.id } },
      update: { userName: USERS.groupAdmin.name, userEmail: USERS.groupAdmin.email, assignedBy: 'system' },
      create: { groupId: g[slug].id, userId: USERS.groupAdmin.id, userName: USERS.groupAdmin.name, userEmail: USERS.groupAdmin.email, assignedBy: 'system' },
    });
    await auditOnce('GROUP_ADMIN_ASSIGNED', 'system', 'System', {
      targetUserId: USERS.groupAdmin.id, targetUserName: USERS.groupAdmin.name, groupId: g[slug].id,
    });
  }
  console.log('Seeded extra admins: Neha (AWS platform admin), Yogesh (Config Management + Payments Secrets group admin)');

  // ── Active grants: each backed by its own PROVISIONED originating request,
  // spread across all four users and every platform. ──
  const now = Date.now();
  const grants = [
    { user: USERS.superAdmin, group: g['platform-engineering'], level: null, duration: 'PERMANENT', expiresInMs: null },
    { user: USERS.superAdmin, group: g['config-management'], level: null, duration: 'PERMANENT', expiresInMs: null },
    { user: USERS.superAdmin, group: g['retention'], level: null, duration: 'ONE_MONTH', expiresInMs: 3 * 24 * 60 * 60 * 1000 }, // expiring soon, for the dashboard's "expiring" widget
    { user: USERS.platformAdmin, group: g['credit-card'], level: lvl['senior-dev'], duration: 'PERMANENT', expiresInMs: null },
    { user: USERS.platformAdmin, group: g['sandbox-secrets'], level: null, duration: 'PERMANENT', expiresInMs: null },
    { user: USERS.platformAdmin, group: g['credit-card-qa'], level: null, duration: 'PERMANENT', expiresInMs: null },
    { user: USERS.groupAdmin, group: g['payments-secrets'], level: null, duration: 'PERMANENT', expiresInMs: null },
    { user: USERS.groupAdmin, group: g['customer-support'], level: null, duration: 'PERMANENT', expiresInMs: null },
    { user: USERS.user, group: g['lending'], level: null, duration: 'PERMANENT', expiresInMs: null },
    { user: USERS.user, group: g['feature-flags'], level: null, duration: 'THREE_MONTHS', expiresInMs: 90 * 24 * 60 * 60 * 1000 },
    { user: USERS.user, group: g['growth-qa'], level: null, duration: 'PERMANENT', expiresInMs: null },
  ];

  for (const gr of grants) {
    if (!gr.group) {continue;}
    const expiresAt = gr.expiresInMs ? new Date(now + gr.expiresInMs) : null;

    const existingReq = await prisma.accessRequest.findFirst({
      where: { requesterId: gr.user.id, groupId: gr.group.id, levelId: gr.level?.id ?? null, status: 'PROVISIONED' },
    });
    const req = existingReq ?? await prisma.accessRequest.create({
      data: {
        groupId: gr.group.id,
        levelId: gr.level?.id ?? null,
        requesterId: gr.user.id,
        requesterName: gr.user.name,
        requesterEmail: gr.user.email,
        justification: `Ongoing work requires ${gr.group.name}${gr.level ? ` (${gr.level.name})` : ''} access.`,
        duration: gr.duration as any,
        expiresAt,
        status: 'PROVISIONED',
        reviewerId: USERS.platformAdmin.id,
        reviewerName: USERS.platformAdmin.name,
        reviewedAt: new Date(now - 5 * 24 * 60 * 60 * 1000),
        provisionedAt: new Date(now - 5 * 24 * 60 * 60 * 1000),
      },
    });

    const existingAccess = await prisma.userAccess.findFirst({
      where: { userId: gr.user.id, groupId: gr.group.id, isActive: true },
    });
    if (!existingAccess) {
      await prisma.userAccess.create({
        data: {
          userId: gr.user.id,
          userName: gr.user.name,
          userEmail: gr.user.email,
          groupId: gr.group.id,
          levelId: gr.level?.id ?? null,
          isActive: true,
          expiresAt,
          grantedBy: USERS.platformAdmin.name,
          accessRequestId: req.id,
        },
      });
      await auditOnce('ACCESS_GRANTED', USERS.platformAdmin.id, USERS.platformAdmin.name, {
        targetUserId: gr.user.id, targetUserName: gr.user.name, groupId: gr.group.id, accessRequestId: req.id,
      });
    }
  }
  console.log(`Seeded ${grants.filter((x) => x.group).length} active access grants across all four users.`);

  // ── Pending requests: sitting in the approval queue, none overlapping a
  // group the same requester already holds active access to. ──
  const pending = [
    { user: USERS.user, group: g['data-science'], level: null, justification: 'Need read access to SageMaker notebooks for the Q3 churn model.' },
    { user: USERS.user, group: g['credit-card'], level: lvl['junior-dev'], justification: 'Picking up credit card dashboard tickets this sprint.' },
    { user: USERS.platformAdmin, group: g['platform-engineering'], level: null, justification: 'Need infra access to debug the deploy pipeline.' },
    { user: USERS.superAdmin, group: g['marketing'], level: null, justification: 'Reviewing campaign spend for the board deck.' },
    { user: USERS.groupAdmin, group: g['data-science'], level: null, justification: 'Cross-referencing growth cohorts against the data science warehouse.' },
    { user: USERS.platformAdmin, group: g['feature-flags'], level: null, justification: 'Rolling out the new onboarding flag to 10% of users.' },
  ];
  for (const p of pending) {
    if (!p.group) {continue;}
    const existing = await prisma.accessRequest.findFirst({
      where: { requesterId: p.user.id, groupId: p.group.id, status: { in: ['PENDING', 'WAITING_FOR_SETUP'] } },
    });
    if (existing) {continue;}
    const req = await prisma.accessRequest.create({
      data: {
        groupId: p.group.id,
        levelId: p.level?.id ?? null,
        requesterId: p.user.id,
        requesterName: p.user.name,
        requesterEmail: p.user.email,
        justification: p.justification,
        duration: 'PERMANENT',
        status: 'PENDING',
      },
    });
    await prisma.auditEntry.create({
      data: {
        action: 'REQUEST_CREATED', performerId: p.user.id, performerName: p.user.name,
        groupId: p.group.id, accessRequestId: req.id,
      },
    });
  }
  console.log(`Seeded ${pending.filter((x) => x.group).length} pending access requests.`);

  // ── One historical rejected request, for texture on "My Requests". ──
  if (g['marketing']) {
    const existingRejected = await prisma.accessRequest.findFirst({
      where: { requesterId: USERS.user.id, groupId: g['marketing'].id, status: 'REJECTED' },
    });
    if (!existingRejected) {
      const req = await prisma.accessRequest.create({
        data: {
          groupId: g['marketing'].id,
          requesterId: USERS.user.id, requesterName: USERS.user.name, requesterEmail: USERS.user.email,
          justification: 'Want visibility into campaign performance for a side project.',
          duration: 'PERMANENT',
          status: 'REJECTED',
          reviewerId: USERS.platformAdmin.id, reviewerName: USERS.platformAdmin.name,
          reviewNote: 'Marketing data requires the data-handling training first — please complete it and reapply.',
          reviewedAt: new Date(now - 10 * 24 * 60 * 60 * 1000),
        },
      });
      await prisma.auditEntry.create({
        data: {
          action: 'REQUEST_REJECTED', performerId: USERS.platformAdmin.id, performerName: USERS.platformAdmin.name,
          targetUserId: USERS.user.id, targetUserName: USERS.user.name, groupId: g['marketing'].id, accessRequestId: req.id,
        },
      });
    }
  }
  console.log('Seeded 1 historical rejected request.');

  // ── ZooKeeper change requests — PENDING, APPLYING (transient), APPLIED (terminal). ──
  if (g['config-management'] && g['feature-flags']) {
    await zkRequestOnce({
      requester: USERS.user, group: g['config-management'], status: 'PENDING',
      changes: [{ path: '/hermes/config/max_retries', action: 'SET', oldValue: '3', newValue: '5', groupId: g['config-management'].id, groupName: g['config-management'].name }],
      justification: 'Bumping retry count after last week\'s timeout incident.',
    });
    await zkRequestOnce({
      requester: USERS.groupAdmin, group: g['payments-secrets'] ?? g['config-management'], status: 'APPLYING',
      changes: [{ path: '/hermes/config/rate_limit_rps', action: 'SET', oldValue: '50', newValue: '100', groupId: g['config-management'].id, groupName: g['config-management'].name, decision: 'APPROVED' }],
      justification: 'Doubling the rate limit for the new partner integration.',
      reviewer: USERS.superAdmin,
    });
    await zkRequestOnce({
      requester: USERS.superAdmin, group: g['feature-flags'], status: 'APPLIED',
      changes: [{ path: '/hermes/feature-flags/new_onboarding_flow', action: 'CREATE', oldValue: null, newValue: 'true', groupId: g['feature-flags'].id, groupName: g['feature-flags'].name, decision: 'APPROVED', applied: true }],
      justification: 'Enabling the new onboarding flow for the beta cohort.',
      reviewer: USERS.platformAdmin,
      applied: true,
    });
  }
  console.log('Seeded 3 ZooKeeper change requests (PENDING, APPLYING, APPLIED).');

  // ── Secret Ingestion requests — PENDING, APPLYING (transient), APPLIED
  // (terminal — values redacted per the real apply-time behavior). ──
  if (g['payments-secrets'] && g['sandbox-secrets']) {
    await secretRequestOnce({
      requester: USERS.user, group: g['payments-secrets'], platform: 'secrets', status: 'PENDING',
      secretName: 'payment/webhook',
      entries: [{ key: 'STRIPE_WEBHOOK_SECRET', value: 'whsec_demo_1234567890abcdef' }],
      justification: 'Adding the webhook secret for the new Stripe endpoint.',
    });
    await secretRequestOnce({
      requester: USERS.groupAdmin, group: g['sandbox-secrets'], platform: 'secrets-sandbox', status: 'APPLYING',
      secretName: 'sandbox/service-a',
      entries: [{ key: 'SANDBOX_DB_PASSWORD', value: 'demo_password_change_me', decision: 'APPROVED' }],
      justification: 'Rotating the sandbox DB password after the staging reset.',
      reviewer: USERS.superAdmin,
    });
    await secretRequestOnce({
      requester: USERS.platformAdmin, group: g['payments-secrets'], platform: 'secrets', status: 'APPLIED',
      secretName: 'payment/gateway',
      entries: [{ key: 'STRIPE_API_KEY', value: null, decision: 'APPROVED', applied: true }], // redacted — terminal status
      justification: 'Refreshing the Stripe API key after the quarterly rotation.',
      reviewer: USERS.superAdmin,
      applied: true,
    });
  }
  console.log('Seeded 3 Secret Ingestion requests (PENDING, APPLYING, APPLIED).');

  // ── A few notifications so the bell icon isn't empty either. ──
  await notifyOnce(USERS.groupAdmin.id, 'New access request pending', 'Rishit Goel requested access to Data Science (AWS). Review it in Pending Approvals.', '/hermes/approvals');
  await notifyOnce(USERS.platformAdmin.id, 'New ZooKeeper change request', 'A change to Config Management is awaiting your review.', '/hermes/approvals');
  await notifyOnce(USERS.user.id, 'Access request submitted', 'Your request for Data Science (AWS) is pending review.', '/hermes/my-requests');
  await notifyOnce(USERS.superAdmin.id, 'Access expiring soon', 'Your access to Retention (Redash) expires in 3 days.', '/hermes');
  console.log('Seeded 4 notifications.');
}

// Idempotent audit-entry insert — since audit_entries has no natural unique
// key, we de-dupe on (action, performerId, targetUserId, groupId) so re-running
// the seed doesn't pile up duplicate rows.
async function auditOnce(
  action: string,
  performerId: string,
  performerName: string,
  extra: { targetUserId?: string; targetUserName?: string; groupId?: string; accessRequestId?: string; details?: any },
) {
  const existing = await prisma.auditEntry.findFirst({
    where: { action, performerId, targetUserId: extra.targetUserId ?? null, groupId: extra.groupId ?? null },
  });
  if (existing) {return;}
  await prisma.auditEntry.create({ data: { action, performerId, performerName, ...extra } });
}

async function zkRequestOnce(opts: {
  requester: { id: string; name: string; email: string };
  group: { id: string; name: string };
  status: string;
  changes: any[];
  justification: string;
  reviewer?: { id: string; name: string };
  applied?: boolean;
}) {
  const existing = await prisma.zookeeperChangeRequest.findFirst({
    where: { requesterId: opts.requester.id, groupId: opts.group.id, status: opts.status as any },
  });
  if (existing) {return;}
  const now = new Date();
  await prisma.zookeeperChangeRequest.create({
    data: {
      requesterId: opts.requester.id, requesterName: opts.requester.name, requesterEmail: opts.requester.email,
      groupId: opts.group.id, groupIds: [opts.group.id],
      status: opts.status as any,
      changes: opts.changes,
      justification: opts.justification,
      reviewerId: opts.reviewer?.id, reviewerName: opts.reviewer?.name,
      reviewedAt: opts.reviewer ? now : null,
      appliedAt: opts.applied ? now : null,
    },
  });
}

async function secretRequestOnce(opts: {
  requester: { id: string; name: string; email: string };
  group: { id: string; name: string };
  platform: string;
  status: string;
  secretName: string;
  entries: any[];
  justification: string;
  reviewer?: { id: string; name: string };
  applied?: boolean;
}) {
  const existing = await prisma.secretIngestionRequest.findFirst({
    where: { requesterId: opts.requester.id, groupId: opts.group.id, secretName: opts.secretName, status: opts.status as any },
  });
  if (existing) {return;}
  const now = new Date();
  const row = await prisma.secretIngestionRequest.create({
    data: {
      requesterId: opts.requester.id, requesterName: opts.requester.name, requesterEmail: opts.requester.email,
      groupId: opts.group.id, platform: opts.platform,
      secretName: opts.secretName,
      entries: opts.entries,
      justification: opts.justification,
      status: opts.status as any,
      reviewerId: opts.reviewer?.id, reviewerName: opts.reviewer?.name,
      reviewedAt: opts.reviewer ? now : null,
      appliedAt: opts.applied ? now : null,
    },
  });
  await prisma.auditEntry.create({
    data: {
      action: 'SECRET_INGESTION_SUBMITTED', performerId: opts.requester.id, performerName: opts.requester.name, groupId: opts.group.id,
      details: {
        requestId: row.id,
        secretName: opts.secretName,
        keyCount: opts.entries.length,
        keys: opts.entries.map((e) => e.key),
        justification: opts.justification,
        batchId: null,
      },
    },
  });
}

async function notifyOnce(userId: string, title: string, message: string, linkUrl: string) {
  const existing = await prisma.notification.findFirst({ where: { userId, title } });
  if (existing) {return;}
  await prisma.notification.create({ data: { userId, title, message, linkUrl } });
}

main()
  .catch((e) => {
    console.error('Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
