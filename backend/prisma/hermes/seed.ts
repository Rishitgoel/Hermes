import { PrismaClient } from '@prisma/client';
import config from '../../src/config/config';

const prisma = new PrismaClient();

const initialGroups = [
  {
    name: 'Growth',
    slug: 'growth',
    description: 'Access to growth analytics dashboards and user acquisition metrics.',
    icon: 'TrendingUp',
    color: '#6B46C1', // Purple
    externalGroupId: '101', // Mock Redash Group ID
    tables: ['growth_analytics', 'conversion_funnels', 'acquisition_channels', 'attribution_models'],
  },
  {
    name: 'Retention',
    slug: 'retention',
    description: 'Access to customer retention metrics and churn analysis datasets.',
    icon: 'RefreshCw',
    color: '#6B46C1', // Purple
    externalGroupId: '102', // Mock Redash Group ID
    tables: ['churn_predictions', 'user_engagement_logs', 'lifecycle_events', 'reactivation_campaigns'],
  },
  {
    name: 'Lending',
    slug: 'lending',
    description: 'Access to consumer lending databases and loan risk profiles.',
    icon: 'DollarSign',
    color: '#6B46C1', // Purple
    externalGroupId: '103', // Mock Redash Group ID
    tables: ['loan_applications', 'underwriting_rules', 'risk_profiles', 'emi_schedules', 'disbursals'],
  },
  {
    name: 'Customer Support',
    slug: 'customer-support',
    description: 'Access to customer experience databases, ticket data, and agent metrics.',
    icon: 'HeartHandshake',
    color: '#6B46C1', // Purple
    externalGroupId: '105', // Mock Redash Group ID
    tables: ['support_tickets', 'agent_performance', 'customer_feedback', 'escalation_logs'],
  },
  {
    name: 'Credit Card',
    slug: 'credit-card',
    description: 'Access to credit card transactions ledger and billing databases.',
    icon: 'CreditCard',
    color: '#6B46C1', // Purple
    externalGroupId: '104', // Mock Redash Group ID
    tables: ['card_transactions', 'credit_limits', 'rewards_ledger', 'billing_statements'],
  },
  {
    name: 'Marketing',
    slug: 'marketing',
    description: 'Access to marketing campaign performance, ad spend, and promotion metrics.',
    icon: 'Megaphone',
    color: '#6B46C1', // Purple
    externalGroupId: '106', // Mock Redash Group ID
    tables: ['ad_spend', 'campaign_metrics', 'email_deliverability', 'promo_codes'],
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
      // platform is required (no schema default). All seeded groups are Redash.
      create: { ...group, platform: 'redash' },
    });
    console.log(`Upserted group: ${upserted.name} (${upserted.slug})`);
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

  // Seed Redash and Azure Key Vault platform admins (mirrors simulation identities)
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

  console.log('Seeding default platform admin for Azure Key Vault (secrets-azure)...');
  await prisma.platformAdmin.upsert({
    where: {
      userId_platform: {
        userId: 'platform-admin-uuid-4444',
        platform: 'secrets-azure',
      },
    },
    update: {
      userName: 'Neha_Sharma',
      userEmail: 'neha.sharma@bachatt.app',
      assignedBy: 'system',
    },
    create: {
      userId: 'platform-admin-uuid-4444',
      platform: 'secrets-azure',
      userName: 'Neha_Sharma',
      userEmail: 'neha.sharma@bachatt.app',
      assignedBy: 'system',
    },
  });
  console.log('Seeded Azure Key Vault platform admin: Neha Sharma');

  // Seed sample Secret Ingestion Requests for Azure Key Vault
  console.log('Seeding sample Azure Key Vault Secret Ingestion requests...');

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

  // Seed matching audit logs for Azure Key Vault events
  const existingAudit = await prisma.auditEntry.findFirst({
    where: { action: 'SECRET_INGESTION_REQUEST_CREATED' },
  });
  if (!existingAudit) {
    await prisma.auditEntry.create({
      data: {
        action: 'SECRET_INGESTION_REQUEST_CREATED',
        performerId: 'regular-user-uuid-3333',
        performerName: 'Rishit_Goel',
        performerEmail: 'rishit.goel@bachatt.app',
        platform: 'secrets-azure',
        targetType: 'azure-keyvault',
        targetName: 'bachatt-sim-kv',
        details: {
          keys: ['orbit-azure-openai-api-key', 'saathi-azure-storage-key'],
          vault: 'bachatt-sim-kv',
          justification: 'Rotate Azure OpenAI API key and update Saathi blob storage connection string.',
        },
      },
    });
    await prisma.auditEntry.create({
      data: {
        action: 'SECRET_INGESTION_APPROVED',
        performerId: 'platform-admin-uuid-4444',
        performerName: 'Neha_Sharma',
        performerEmail: 'neha.sharma@bachatt.app',
        platform: 'secrets-azure',
        targetType: 'azure-keyvault',
        targetName: 'bachatt-sim-kv-analytics',
        details: {
          keys: ['metabase-db-password', 'metabase-encryption-key'],
          vault: 'bachatt-sim-kv-analytics',
          prNumber: 108,
        },
      },
    });
    console.log('Seeded Azure Key Vault audit log entries');
  }

  console.log('Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
