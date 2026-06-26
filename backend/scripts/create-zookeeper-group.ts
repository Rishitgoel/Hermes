/**
 * Seed a demo ZooKeeper-backed Hermes `Group` with read-only and read-write levels,
 * so the `zookeeper` platform is browsable/requestable end-to-end. The interactive
 * path is the Admin Management UI ("New group" + the group drawer's Levels tab); this
 * script is just for quick local/demo setup.
 *
 * ZooKeeper model (see zookeeper.service.ts): a group is a znode PATH, and each level
 * is "<path>#<perms>" where perms are ZK ACL letters (c/d/r/w/a). The backing znodes
 * are created lazily on first provision, so no live ZooKeeper is needed in simulation.
 *
 * Idempotent: re-running updates the group (keyed on slug) and its two levels. The
 * group/level upsert is exported as {@link upsertZookeeperGroup} so other scripts
 * (e.g. seed-zookeeper-mock.ts) can reuse it without shelling out.
 *
 * Usage (from the backend/ directory):
 *   npx ts-node scripts/create-zookeeper-group.ts                       # "Credit Card" → /hermes/credit-card
 *   npx ts-node scripts/create-zookeeper-group.ts "Config Store" /hermes/config-store
 */
import prisma from '../src/config/prisma';
import config from '../src/config/config';

const PLATFORM = 'zookeeper';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Create/update a ZooKeeper-backed Hermes group (keyed on slug) plus its read-only and
 * read-write levels. `path` defaults to "<ZOOKEEPER_ROOT_PATH>/<slug>". Does NOT manage
 * the Prisma connection — the caller owns connect/disconnect.
 */
export async function upsertZookeeperGroup(
  name: string,
  path?: string,
): Promise<{ id: string; slug: string; name: string; externalGroupId: string | null }> {
  const slug = slugify(name);
  const root = config.zookeeper.rootPath.replace(/\/$/, '');
  const znodePath = path || `${root}/${slug}`;

  const group = await prisma.group.upsert({
    where: { slug },
    update: { name, platform: PLATFORM, externalGroupId: znodePath, icon: 'Network', color: '#326CE5' },
    create: {
      slug,
      name,
      description: `ZooKeeper access to the ${znodePath} znode subtree. Levels grant different ACL permission tiers (read vs read-write).`,
      icon: 'Network',
      color: '#326CE5',
      platform: PLATFORM,
      externalGroupId: znodePath,
      tables: [],
    },
  });

  const levels = [
    { name: 'Read Only', slug: 'read-only', permission: 'read-only', externalGroupId: `${znodePath}#r`, rank: 1 },
    { name: 'Read / Write', slug: 'read-write', permission: 'read-write', externalGroupId: `${znodePath}#cdrw`, rank: 2 },
  ];

  for (const lvl of levels) {
    await prisma.groupLevel.upsert({
      where: { groupId_slug: { groupId: group.id, slug: lvl.slug } },
      update: { name: lvl.name, permission: lvl.permission, externalGroupId: lvl.externalGroupId, rank: lvl.rank, isActive: true },
      create: { groupId: group.id, ...lvl },
    });
  }

  return { id: group.id, slug: group.slug, name: group.name, externalGroupId: group.externalGroupId };
}

async function main() {
  const name = process.argv[2] || 'Credit Card';
  const path = process.argv[3];

  console.log(`Creating/updating Hermes ZooKeeper group "${name}"…`);
  const group = await upsertZookeeperGroup(name, path);
  console.log(`  levels ready: "Read Only" → ${group.externalGroupId}#r, "Read / Write" → ${group.externalGroupId}#cdrw`);
  console.log(`\n✅ ZooKeeper group ready: "${group.name}" (slug: ${group.slug}, znode: ${group.externalGroupId})`);
  console.log('   It will now appear under the ZooKeeper platform in the Groups page.');
}

// Only run the CLI when invoked directly, not when imported by another script.
if (require.main === module) {
  main()
    .catch((e) => {
      console.error('Error:', e?.message || e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
