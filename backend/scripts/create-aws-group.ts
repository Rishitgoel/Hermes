/**
 * Create (or update) a Hermes `Group` row backed by an AWS IAM Identity Center group,
 * so the group becomes browsable/requestable in the UI. There is no group-creation
 * API/UI yet — groups come from the seed or a script like this one.
 *
 * Idempotent: re-running updates the existing row (keyed on slug).
 *
 * Usage (from the backend/ directory):
 *   npx ts-node scripts/create-aws-group.ts                 # maps "API-TESTING"
 *   npx ts-node scripts/create-aws-group.ts "Data Platform" # maps another IDC group
 *
 * The Identity Store group id is resolved in this order:
 *   1. the platform_external_groups cache (populated by the periodic / manual sync)
 *   2. a live Identity Center lookup by display name
 *   3. (only for API-TESTING) a known fallback id
 */
import prisma from '../src/config/prisma';
import awsIdentityCenterService from '../src/services/aws-identity-center.service';

const PLATFORM = 'aws';
// Known id for the group verified during integration testing — used only as a
// last-resort fallback for API-TESTING when the cache/live lookup come up empty.
const API_TESTING_FALLBACK_ID = '24c884c8-00e1-7087-3b3e-df408195719a';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function resolveExternalGroupId(name: string): Promise<string | null> {
  // 1. cache (no AWS call)
  const cached = await prisma.platformExternalGroup.findFirst({
    where: { platform: PLATFORM, name },
  });
  if (cached) {
    console.log(`  resolved external id from cache: ${cached.externalId}`);
    return cached.externalId;
  }
  // 2. live lookup (works in simulation too)
  try {
    const live = await awsIdentityCenterService.getGroupIdByName(name);
    if (live) {
      console.log(`  resolved external id from live Identity Center: ${live}`);
      return live;
    }
  } catch (err: any) {
    console.warn(`  live lookup failed (${err?.name || err?.message}); will try fallback`);
  }
  // 3. known fallback (API-TESTING only)
  if (name === 'API-TESTING') {
    console.log(`  using known fallback id for API-TESTING: ${API_TESTING_FALLBACK_ID}`);
    return API_TESTING_FALLBACK_ID;
  }
  return null;
}

async function main() {
  const name = process.argv[2] || 'API-TESTING';
  const slug = slugify(name);
  console.log(`Creating/updating Hermes AWS group for Identity Center group "${name}" (slug: ${slug})…`);

  const externalGroupId = await resolveExternalGroupId(name);
  if (!externalGroupId) {
    console.error(
      `\n❌ Could not resolve an Identity Store group id for "${name}".\n` +
        `   Run a sync first (POST /api/admin/sync) or check the group's display name in AWS.`,
    );
    process.exitCode = 1;
    return;
  }

  const data = {
    name,
    description: `AWS IAM Identity Center group "${name}". Membership grants the SSO access configured on this group's permission-set assignment.`,
    icon: 'Cloud',
    color: '#FF9900',
    externalGroupId,
    platform: PLATFORM,
  };

  const upserted = await prisma.group.upsert({
    where: { slug },
    update: {
      name: data.name,
      description: data.description,
      icon: data.icon,
      color: data.color,
      externalGroupId: data.externalGroupId,
      platform: data.platform,
    },
    create: { slug, tables: [], ...data },
  });

  console.log(
    `\n✅ Group ready: "${upserted.name}" (slug: ${upserted.slug}, platform: ${upserted.platform}, externalGroupId: ${upserted.externalGroupId})`,
  );
  console.log('   It will now appear under the AWS platform in the Groups page.');
}

main()
  .catch((e) => {
    console.error('Error:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
