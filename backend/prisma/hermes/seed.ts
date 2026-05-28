import { PrismaClient } from '@prisma/client';

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
      create: group,
    });
    console.log(`Upserted group: ${upserted.name} (${upserted.slug})`);
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
