import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import config from '../../src/config/config';

const prisma = new PrismaClient();

const initialGroups = [
  // ── Redash Prod ──
  {
    name: 'Growth',
    slug: 'growth',
    platform: 'redash',
    description: 'Access to growth analytics dashboards and user acquisition metrics.',
    icon: 'TrendingUp',
    color: '#E0402C',
    externalGroupId: '101',
    tables: ['growth_analytics', 'conversion_funnels', 'acquisition_channels', 'attribution_models'],
  },
  {
    name: 'Retention',
    slug: 'retention',
    platform: 'redash',
    description: 'Access to customer retention metrics and churn analysis datasets.',
    icon: 'RefreshCw',
    color: '#E0402C',
    externalGroupId: '102',
    tables: ['churn_predictions', 'user_engagement_logs', 'lifecycle_events', 'reactivation_campaigns'],
  },
  {
    name: 'Lending',
    slug: 'lending',
    platform: 'redash',
    description: 'Access to consumer lending databases and loan risk profiles.',
    icon: 'DollarSign',
    color: '#E0402C',
    externalGroupId: '103',
    tables: ['loan_applications', 'underwriting_rules', 'risk_profiles', 'emi_schedules', 'disbursals'],
  },
  {
    name: 'Credit Card',
    slug: 'credit-card',
    platform: 'redash',
    description: 'Access to credit card transactions ledger and billing databases.',
    icon: 'CreditCard',
    color: '#E0402C',
    externalGroupId: '104',
    tables: ['card_transactions', 'credit_limits', 'rewards_ledger', 'billing_statements'],
  },
  {
    name: 'Customer Support',
    slug: 'customer-support',
    platform: 'redash',
    description: 'Access to customer experience databases, ticket data, and agent metrics.',
    icon: 'HeartHandshake',
    color: '#E0402C',
    externalGroupId: '105',
    tables: ['support_tickets', 'agent_performance', 'customer_feedback', 'escalation_logs'],
  },

  // ── Redash QA ──
  {
    name: 'QA Staging Analytics',
    slug: 'qa-staging-analytics',
    platform: 'redash-qa',
    description: 'Access to QA test datasets, synthetic user logs, and benchmark queries.',
    icon: 'Database',
    color: '#E0402C',
    externalGroupId: '201',
    tables: ['test_user_events', 'sandbox_transactions', 'load_test_results'],
  },

  // ── AWS IAM Identity Center ──
  {
    name: 'AWS Infrastructure Admin',
    slug: 'aws-infra-admin',
    platform: 'aws',
    description: 'Cloud infrastructure SSO group providing IAM Identity Center admin rights.',
    icon: 'Cloud',
    color: '#FF9900',
    externalGroupId: 'aws-grp-001',
    tables: ['aws_account_roles', 'iam_policy_sets', 'security_groups'],
  },
  {
    name: 'AWS Data Engineering',
    slug: 'aws-data-engineering',
    platform: 'aws',
    description: 'AWS SSO access to EKS, S3 Data Lake, EMR clusters, and Redshift spectrum.',
    icon: 'Layers',
    color: '#FF9900',
    externalGroupId: 'aws-grp-002',
    tables: ['s3_lakehouse', 'redshift_warehouse', 'emr_logs'],
  },

  // ── Apache ZooKeeper ──
  {
    name: 'ZK Credit Card Node',
    slug: 'zk-credit-card-node',
    platform: 'zookeeper',
    description: 'Distributed znode coordination path for Credit Card service config and ACLs.',
    icon: 'Network',
    color: '#326CE5',
    externalGroupId: '/hermes/credit-card#cdrw\n/hermes/payments#r',
    tables: ['znode_paths', 'acl_permissions'],
  },
  {
    name: 'ZK Core Gateway',
    slug: 'zk-core-gateway',
    platform: 'zookeeper',
    description: 'ZooKeeper path access for API Gateway dynamic feature flags and rate limit nodes.',
    icon: 'Radio',
    color: '#326CE5',
    externalGroupId: '/hermes/core-gateway#cdrw',
    tables: ['feature_flags', 'rate_limit_rules'],
  },

  // ── Secret Ingestion (AWS Secrets Manager - Prod) ──
  {
    name: 'Production Secrets Ingestion',
    slug: 'prod-secrets-ingestion',
    platform: 'secrets',
    description: 'Stage and review key-value secrets destined for AWS Secrets Manager (Prod & QA).',
    icon: 'KeyRound',
    color: '#DD344C',
    externalGroupId: '*',
    tables: ['secrets_manager_keys', 'infra_deployment_prs'],
  },

  // ── Secret Ingestion Sandbox (AWS Secrets Manager - Sandbox) ──
  {
    name: 'Sandbox Microservice Secrets',
    slug: 'sandbox-secrets-ingestion',
    platform: 'secrets-sandbox',
    description: 'Ingest secret key-value pairs into AWS Secrets Manager Sandbox environment.',
    icon: 'KeyRound',
    color: '#DD344C',
    externalGroupId: 'sandbox-*',
    tables: ['sandbox_secret_keys'],
  },

  // ── Secret Ingestion Azure (Azure Key Vault) ──
  {
    name: 'Azure Key Vault Secrets',
    slug: 'azure-kv-secrets',
    platform: 'secrets-azure',
    description: 'Ingest and stage flat key-value pairs in Azure Key Vault instances.',
    icon: 'Server',
    color: '#0078D4',
    externalGroupId: 'bachatt-sim-kv\nbachatt-sim-kv-analytics',
    tables: ['azure_keyvault_secrets'],
  },
];

async function main() {
  console.log('Seeding initial Hermes groups across all platforms...');

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
        platform: group.platform,
      },
      create: { ...group },
    });
    console.log(`Upserted group: ${upserted.name} (${upserted.slug}) [${upserted.platform}]`);
  }

  // ── Seed Permission Levels for Credit Card (Redash) ──
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
    console.log('Seeded Credit Card permission levels');
  }

  // ── Seed Permission Levels for AWS Data Engineering ──
  const awsDataEng = await prisma.group.findUnique({ where: { slug: 'aws-data-engineering' } });
  if (awsDataEng) {
    const awsLevels = [
      { name: 'Analyst', slug: 'analyst', permission: 'read-only', externalGroupId: 'aws-lvl-001', rank: 0, description: 'S3 Data Lake Read-Only analytics access.' },
      { name: 'Engineer', slug: 'engineer', permission: 'write', externalGroupId: 'aws-lvl-002', rank: 1, description: 'Read/Write access to EKS and Redshift warehouse.' },
    ];
    for (const lvl of awsLevels) {
      await prisma.groupLevel.upsert({
        where: { groupId_slug: { groupId: awsDataEng.id, slug: lvl.slug } },
        update: { name: lvl.name, permission: lvl.permission, externalGroupId: lvl.externalGroupId, rank: lvl.rank, description: lvl.description },
        create: { groupId: awsDataEng.id, ...lvl },
      });
    }
    console.log('Seeded AWS Data Engineering permission levels');
  }

  if (!config.isSimulation) {
    console.log('Skipping sim admin/access/request fixtures in live mode.');
    console.log('Seeding completed successfully!');
    return;
  }

  // ── Seed Group Admins ──
  console.log('Seeding group admins...');
  const growthGroup = await prisma.group.findUnique({ where: { slug: 'growth' } });
  if (growthGroup) {
    await prisma.groupAdmin.upsert({
      where: { groupId_userId: { groupId: growthGroup.id, userId: 'group-admin-uuid-2222' } },
      update: { userName: 'Yogesh_Verma', userEmail: 'yogesh.verma@bachatt.app', assignedBy: 'system' },
      create: { groupId: growthGroup.id, userId: 'group-admin-uuid-2222', userName: 'Yogesh_Verma', userEmail: 'yogesh.verma@bachatt.app', assignedBy: 'system' },
    });
  }

  // ── Seed Platform Admins ──
  console.log('Seeding platform admins...');
  const platformAdmins = [
    { userId: 'platform-admin-uuid-4444', platform: 'redash', userName: 'Neha_Sharma', userEmail: 'neha.sharma@bachatt.app' },
    { userId: 'platform-admin-uuid-4444', platform: 'aws', userName: 'Neha_Sharma', userEmail: 'neha.sharma@bachatt.app' },
    { userId: 'platform-admin-uuid-4444', platform: 'zookeeper', userName: 'Neha_Sharma', userEmail: 'neha.sharma@bachatt.app' },
    { userId: 'platform-admin-uuid-4444', platform: 'secrets', userName: 'Neha_Sharma', userEmail: 'neha.sharma@bachatt.app' },
    { userId: 'platform-admin-uuid-4444', platform: 'secrets-azure', userName: 'Neha_Sharma', userEmail: 'neha.sharma@bachatt.app' },
  ];
  for (const pa of platformAdmins) {
    await prisma.platformAdmin.upsert({
      where: { userId_platform: { userId: pa.userId, platform: pa.platform } },
      update: { userName: pa.userName, userEmail: pa.userEmail, assignedBy: 'system' },
      create: { ...pa, assignedBy: 'system' },
    });
  }

  // ── Seed Active User Access Grants ──
  console.log('Seeding active UserAccess grants...');
  if (growthGroup) {
    const existingAccess = await prisma.userAccess.findFirst({
      where: { userId: 'group-admin-uuid-2222', groupId: growthGroup.id, isActive: true },
    });
    if (!existingAccess) {
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
  }

  const zkGroup = await prisma.group.findUnique({ where: { slug: 'zk-credit-card-node' } });
  if (zkGroup) {
    const existingZkAccess = await prisma.userAccess.findFirst({
      where: { userId: 'super-admin-uuid-1111', groupId: zkGroup.id, isActive: true },
    });
    if (!existingZkAccess) {
      await prisma.userAccess.create({
        data: {
          userId: 'super-admin-uuid-1111',
          groupId: zkGroup.id,
          userName: 'Mayank_Aggarwal',
          userEmail: 'mayank.aggarwal@bachatt.app',
          isActive: true,
          grantedBy: 'system',
        },
      });
    }
  }

  // ── Seed Access Requests ──
  console.log('Seeding access requests...');
  const pendingReq = await prisma.accessRequest.findFirst({
    where: { requesterId: 'regular-user-uuid-3333', status: 'PENDING' },
  });
  if (!pendingReq && awsDataEng) {
    await prisma.accessRequest.create({
      data: {
        groupId: awsDataEng.id,
        requesterId: 'regular-user-uuid-3333',
        requesterName: 'Rishit_Goel',
        requesterEmail: 'rishit.goel@bachatt.app',
        status: 'PENDING',
        justification: 'Need AWS SSO access for S3 Data Lake analysis in Q3 campaign review.',
        duration: 'ONE_MONTH',
      },
    });
    console.log('Seeded PENDING access request for AWS Data Engineering');
  }

  const approvedReq = await prisma.accessRequest.findFirst({
    where: { requesterId: 'group-admin-uuid-2222', status: 'APPROVED' },
  });
  if (!approvedReq && growthGroup) {
    await prisma.accessRequest.create({
      data: {
        groupId: growthGroup.id,
        requesterId: 'group-admin-uuid-2222',
        requesterName: 'Yogesh_Verma',
        requesterEmail: 'yogesh.verma@bachatt.app',
        reviewerId: 'super-admin-uuid-1111',
        reviewerName: 'Mayank_Aggarwal',
        status: 'APPROVED',
        justification: 'Growth Analytics dashboard oversight and user acquisition tracking.',
        duration: 'PERMANENT',
        reviewedAt: new Date(Date.now() - 86400000 * 5),
      },
    });
    console.log('Seeded APPROVED access request for Growth');
  }

  // ── Seed User Onboarding Creation Requests ──
  console.log('Seeding UserCreationRequest rows...');
  const platformsToCreate = ['redash', 'aws', 'zookeeper', 'secrets'];
  for (const plat of platformsToCreate) {
    const existing = await prisma.userCreationRequest.findFirst({
      where: { userId: 'super-admin-uuid-1111', platform: plat },
    });
    if (!existing) {
      await prisma.userCreationRequest.create({
        data: {
          userId: 'super-admin-uuid-1111',
          userName: 'Mayank_Aggarwal',
          userEmail: 'mayank.aggarwal@bachatt.app',
          platform: plat,
          status: 'COMPLETED',
          justification: 'Super Admin onboarding completed.',
          completedAt: new Date(),
        },
      });
    }
  }

  // ── Seed Secret Ingestion Requests (AWS Secrets Manager - Prod) ──
  console.log('Seeding AWS Secrets Manager Ingestion requests...');
  const pendingSecretsReq = await prisma.secretIngestionRequest.findFirst({
    where: { platform: 'secrets', status: 'PENDING' },
  });
  if (!pendingSecretsReq) {
    await prisma.secretIngestionRequest.create({
      data: {
        platform: 'secrets',
        secretName: 'investments-prod-db',
        requesterId: 'regular-user-uuid-3333',
        requesterName: 'Rishit_Goel',
        requesterEmail: 'rishit.goel@bachatt.app',
        status: 'PENDING',
        justification: 'Rotate Postgres database credentials and Redis auth token for Investments microservice.',
        entries: [
          { key: 'INVESTMENTS_DB_PASSWORD', value: 'pg_inv_prod_pass_2026_x9', envVar: 'DB_PASSWORD' },
          { key: 'INVESTMENTS_REDIS_AUTH', value: 'redis_auth_token_9918273645', envVar: 'REDIS_AUTH' },
        ],
        infraTargets: [
          { path: 'deploy/investments/prod/values-prod.yaml', manifestRef: 'investments-prod-db', format: 'helm-values', env: 'prod' },
        ],
        infraSyncState: 'OPEN',
        infraPrNumber: 204,
        infraPrUrl: 'https://github.com/bachatt-app/infra-deployment/pull/204',
      },
    });
    console.log('Seeded PENDING AWS Secrets Manager request (#204)');
  }

  // ── Seed Secret Ingestion Requests (AWS Secrets Manager - Sandbox) ──
  const pendingSandboxReq = await prisma.secretIngestionRequest.findFirst({
    where: { platform: 'secrets-sandbox', status: 'PENDING' },
  });
  if (!pendingSandboxReq) {
    await prisma.secretIngestionRequest.create({
      data: {
        platform: 'secrets-sandbox',
        secretName: 'sandbox-ai-service',
        requesterId: 'regular-user-uuid-3333',
        requesterName: 'Rishit_Goel',
        requesterEmail: 'rishit.goel@bachatt.app',
        status: 'PENDING',
        justification: 'Provision OpenAI sandbox API keys for testing LLM response caching.',
        entries: [
          { key: 'OPENAI_SANDBOX_KEY', value: 'sk-sandbox-mock-key-9988776655', envVar: 'OPENAI_API_KEY' },
        ],
        infraTargets: [
          { path: 'sandbox/ai-service/values-sandbox.yaml', manifestRef: 'sandbox-ai-service', format: 'helm-values', env: 'sandbox' },
        ],
        infraSyncState: 'OPEN',
        infraPrNumber: 45,
        infraPrUrl: 'https://github.com/bachatt-app/infra-deployment-sandbox/pull/45',
      },
    });
    console.log('Seeded PENDING AWS Secrets Manager Sandbox request (#45)');
  }

  // ── Seed Secret Ingestion Requests (Azure Key Vault) ──
  console.log('Seeding Azure Key Vault Secret Ingestion requests...');
  const pendingAzureReq = await prisma.secretIngestionRequest.findFirst({
    where: { platform: 'secrets-azure', status: 'PENDING' },
  });
  if (!pendingAzureReq) {
    await prisma.secretIngestionRequest.create({
      data: {
        platform: 'secrets-azure',
        secretName: 'bachatt-sim-kv',
        requesterId: 'regular-user-uuid-3333',
        requesterName: 'Rishit_Goel',
        requesterEmail: 'rishit.goel@bachatt.app',
        status: 'PENDING',
        justification: 'Rotate Azure OpenAI API key and update Saathi blob storage connection string for Q3 release.',
        entries: [
          { key: 'orbit-azure-openai-api-key', value: 'sk-proj-azure-openai-live-key-v2', envVar: 'AZURE_OPENAI_API_KEY' },
          { key: 'saathi-azure-storage-key', value: 'DefaultEndpointsProtocol=https;AccountName=saathistorage;AccountKey=simKey123==', envVar: 'AZURE_STORAGE_CONNECTION_STRING' },
        ],
        infraTargets: [
          { path: 'azure/orbit/prod/values-prod.yaml', manifestRef: 'bachatt-sim-kv', format: 'azure-values', env: 'prod' },
        ],
        infraSyncState: 'OPEN',
        infraPrNumber: 112,
        infraPrUrl: 'https://github.com/bachatt-app/infra-deployment/pull/112',
      },
    });
    console.log('Seeded PENDING Azure Key Vault ingestion request (#112)');
  }

  const appliedAzureReq = await prisma.secretIngestionRequest.findFirst({
    where: { platform: 'secrets-azure', status: 'APPLIED' },
  });
  if (!appliedAzureReq) {
    await prisma.secretIngestionRequest.create({
      data: {
        platform: 'secrets-azure',
        secretName: 'bachatt-sim-kv-analytics',
        requesterId: 'group-admin-uuid-2222',
        requesterName: 'Yogesh_Verma',
        requesterEmail: 'yogesh.verma@bachatt.app',
        reviewerId: 'platform-admin-uuid-4444',
        reviewerName: 'Neha_Sharma',
        status: 'APPLIED',
        justification: 'Provision Metabase database connection credentials in Azure Key Vault for analytics team.',
        reviewNote: 'Approved. Target Azure values files updated and Key Vault secret written.',
        reviewedAt: new Date(Date.now() - 3600000 * 24),
        appliedAt: new Date(Date.now() - 3600000 * 24),
        entries: [
          { key: 'metabase-db-password', value: 'mb_secure_prod_pass_2026', envVar: 'MB_DB_PASS', decision: 'APPROVED', applied: true },
          { key: 'metabase-encryption-key', value: 'mb_enc_key_99887766554433221100', envVar: 'MB_ENCRYPTION_KEY', decision: 'APPROVED', applied: true },
        ],
        infraTargets: [
          { path: 'azure/metabase/prod/values-prod.yaml', manifestRef: 'bachatt-sim-kv-analytics', format: 'azure-values', env: 'prod' },
        ],
        infraSyncState: 'MERGED',
        infraPrNumber: 108,
        infraPrUrl: 'https://github.com/bachatt-app/infra-deployment/pull/108',
      },
    });
    console.log('Seeded APPLIED Azure Key Vault ingestion request (#108)');
  }

  // ── Seed Audit Log Entries ──
  console.log('Seeding Audit Log entries...');
  const auditEntries = [
    {
      action: 'GROUP_CREATED',
      performerId: 'super-admin-uuid-1111',
      performerName: 'Mayank_Aggarwal',
      details: { groupName: 'AWS Data Engineering', platform: 'aws' },
    },
    {
      action: 'ACCESS_REQUEST_APPROVED',
      performerId: 'super-admin-uuid-1111',
      performerName: 'Mayank_Aggarwal',
      details: { requesterName: 'Yogesh_Verma', groupName: 'Growth', duration: 'PERMANENT' },
    },
    {
      action: 'SECRET_INGESTION_REQUEST_CREATED',
      performerId: 'regular-user-uuid-3333',
      performerName: 'Rishit_Goel',
      details: { keys: ['INVESTMENTS_DB_PASSWORD', 'INVESTMENTS_REDIS_AUTH'], vault: 'investments-prod-db' },
    },
    {
      action: 'SECRET_INGESTION_APPROVED',
      performerId: 'platform-admin-uuid-4444',
      performerName: 'Neha_Sharma',
      details: { keys: ['metabase-db-password', 'metabase-encryption-key'], vault: 'bachatt-sim-kv-analytics', prNumber: 108 },
    },
  ];

  for (const entry of auditEntries) {
    await prisma.auditEntry.create({ data: entry });
  }
  console.log('Seeded Audit Log entries');

  console.log('All Hermes seed data created successfully!');
}

main()
  .catch((e) => {
    console.error('Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
