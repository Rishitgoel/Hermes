/**
 * Seed a demo Secret Ingestion Hermes `Group`,
 * so the `secrets` platform is requestable end-to-end.
 *
 * Usage (from the backend/ directory):
 *   npx ts-node scripts/create-secrets-group.ts                                   # demo payment/* group
 *   npx ts-node scripts/create-secrets-group.ts "All Secrets" "*"                 # every secret (resolved live)
 *   npx ts-node scripts/create-secrets-group.ts "Investments" "investments*"      # prefix scope (resolved live)
 *   npx ts-node scripts/create-secrets-group.ts "Payments" payment/gateway payment/webhook  # exact list
 *
 * A secret name of `*` grants every secret in the account; a trailing-`*` prefix (e.g.
 * `investments*`) grants all names starting with it. Both are expanded live from AWS on each
 * load, so newly-added matching secrets appear automatically without editing the group.
 */
import prisma from '../src/config/prisma';

const PLATFORM = 'secrets';

export async function upsertSecretsGroup(
  name: string,
  secretNames: string[],
): Promise<{ id: string; slug: string; name: string; externalGroupId: string | null }> {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const externalGroupId = secretNames.join('\n');

  const group = await prisma.group.upsert({
    where: { slug },
    update: { name, platform: PLATFORM, externalGroupId, icon: 'KeyRound', color: '#DD344C' },
    create: {
      slug,
      name,
      description: `Secret Ingestion group for managing key-value pairs in: ${secretNames.join(', ')}.`,
      icon: 'KeyRound',
      color: '#DD344C',
      platform: PLATFORM,
      externalGroupId,
      tables: [],
    },
  });

  return { id: group.id, slug: group.slug, name: group.name, externalGroupId: group.externalGroupId };
}

async function main() {
  const name = process.argv[2] || 'Payment Secrets';
  const secrets = process.argv.slice(3);
  const secretNames = secrets.length > 0 ? secrets : ['payment/gateway', 'payment/webhook'];

  console.log(`Creating/updating Hermes Secret Ingestion group "${name}"…`);
  const group = await upsertSecretsGroup(name, secretNames);
  console.log(`\n✅ Secret Ingestion group ready: "${group.name}" (slug: ${group.slug})`);
  console.log('   Associated secrets:\n' + secretNames.map(s => `    - ${s}`).join('\n'));
  console.log('   It will now appear under the Secret Ingestion platform in the Groups page.');
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error('Error:', e?.message || e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
