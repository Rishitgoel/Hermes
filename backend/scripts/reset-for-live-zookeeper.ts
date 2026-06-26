/**
 * One-shot reset / initial sync for switching Hermes from the mock ZooKeeper store to a
 * real ZooKeeper ensemble — the ZooKeeper analogue of reset-for-live-redash.ts /
 * reset-for-live-aws.ts.
 *
 * Unlike Redash/AWS, a ZooKeeper "group" is NOT an id to look up by name — its
 * externalGroupId IS the znode path (admin-authored). So there is nothing to re-map.
 * Going live instead means two things:
 *   1. The sim-minted user state is meaningless against a real ensemble (the digest
 *      aclIds + cached granted paths were minted in-process), so the ZooKeeper cache
 *      rows + change requests are cleared — users re-mint a credential on their next
 *      grant.
 *   2. A fresh ensemble has none of Hermes' backing znodes, so each ZooKeeper Group /
 *      GroupLevel's backing path is created (recursively, under ZOOKEEPER_ROOT_PATH) if
 *      it doesn't already exist.
 *
 * Deliberately ZooKeeper-SCOPED: it only ever touches platform='zookeeper' rows and the
 * live ensemble. It does NOT clear Keycloak admin roles or other platforms' data — that
 * is a full-environment concern already handled by the Redash/AWS reset scripts (running
 * it here would nuke a live Redash/AWS admin too). Existing ZooKeeper access GRANTS are
 * left in place but reported: their holders must be re-provisioned (re-mint) since their
 * sim credentials were cleared.
 *
 * Usage (from backend/):
 *   npx ts-node scripts/reset-for-live-zookeeper.ts            # DRY RUN — prints the plan, writes nothing
 *   npx ts-node scripts/reset-for-live-zookeeper.ts --apply    # executes the plan
 *
 * Requires (live ZooKeeper, same as the running backend would):
 *   ZOOKEEPER_SIMULATION=false, ZOOKEEPER_CONNECT_STRING, ZOOKEEPER_ADMIN_AUTH ("user:password")
 *
 * Safe to re-run. Never deletes Group / GroupLevel rows, never touches the ensemble's
 * own data — only creates missing backing znodes and clears ZooKeeper cache/transient rows.
 */

import prisma from '../src/config/prisma';
import config from '../src/config/config';
import zookeeperService from '../src/services/zookeeper.service';

const PLATFORM = 'zookeeper';
const APPLY = process.argv.includes('--apply');

/** Collect the unique backing znode paths across every ZooKeeper Group + GroupLevel. */
async function collectBackingPaths(): Promise<Map<string, string[]>> {
  // path -> list of "owners" (group/level names) for nicer reporting.
  const byPath = new Map<string, string[]>();
  const add = (externalGroupId: string | null, owner: string) => {
    if (!externalGroupId) return;
    let parsed: { path: string; perms: string }[];
    try {
      parsed = zookeeperService.parseExternalGroupIds(externalGroupId);
    } catch {
      console.log(`  ⚠ ${owner}: malformed externalGroupId "${externalGroupId}" — skipped`);
      return;
    }
    for (const { path } of parsed) {
      const owners = byPath.get(path) ?? [];
      owners.push(owner);
      byPath.set(path, owners);
    }
  };

  const groups = await prisma.group.findMany({ where: { platform: PLATFORM }, orderBy: { name: 'asc' } });
  for (const g of groups) add(g.externalGroupId, g.name);

  const levels = await prisma.groupLevel.findMany({
    where: { group: { platform: PLATFORM } },
    include: { group: true },
    orderBy: { name: 'asc' },
  });
  for (const l of levels) add(l.externalGroupId, `${l.group.name} — ${l.name}`);

  return byPath;
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Hermes reset → live ZooKeeper   [${APPLY ? 'APPLY' : 'DRY RUN'}]`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Connect:    ${config.zookeeper.connectString || '(unset)'}`);
  console.log(`  Root path:  ${config.zookeeper.rootPath}`);
  console.log(`  Mode:       ${config.zookeeper.isSimulation ? 'SIMULATION' : 'LIVE'}`);
  console.log('');

  if (config.zookeeper.isSimulation) {
    console.error(
      '✗ Refusing to run: ZooKeeper is still in simulation mode. Set ZOOKEEPER_SIMULATION=false\n' +
        '  and a real ZOOKEEPER_CONNECT_STRING + ZOOKEEPER_ADMIN_AUTH in backend/.env first.',
    );
    process.exit(1);
  }

  // ── 1. Smoke-test the live ensemble BEFORE writing/deleting anything ─────────
  console.log('Step 1/3 — Verifying the live ZooKeeper ensemble is reachable…');
  const health = await zookeeperService.healthCheck();
  if (!health.healthy) {
    console.error(`✗ Could not reach ZooKeeper: ${health.message ?? 'unknown error'}`);
    console.error('  Nothing was changed. Fix ZOOKEEPER_CONNECT_STRING / ZOOKEEPER_ADMIN_AUTH and retry.');
    process.exit(1);
  }
  console.log('  ✓ Ensemble reachable and admin digest authenticated.');
  console.log('');

  // ── 2. Clear ZooKeeper sim/transient state (cache rows + change requests) ─────
  console.log(`Step 2/3 — Clearing ZooKeeper transient state${APPLY ? '' : ' (preview)'}…`);
  const wipes: Array<[string, () => Promise<number>, () => Promise<number>]> = [
    [
      'zookeeper_change_requests',
      () => prisma.zookeeperChangeRequest.count(),
      () => prisma.zookeeperChangeRequest.deleteMany({}).then((r) => r.count),
    ],
    [
      'platform_external_users (zookeeper)',
      () => prisma.platformExternalUser.count({ where: { platform: PLATFORM } }),
      () => prisma.platformExternalUser.deleteMany({ where: { platform: PLATFORM } }).then((r) => r.count),
    ],
    [
      'platform_external_groups (zookeeper)',
      () => prisma.platformExternalGroup.count({ where: { platform: PLATFORM } }),
      () => prisma.platformExternalGroup.deleteMany({ where: { platform: PLATFORM } }).then((r) => r.count),
    ],
    [
      'user_creation_requests (zookeeper)',
      () => prisma.userCreationRequest.count({ where: { platform: PLATFORM } }),
      () => prisma.userCreationRequest.deleteMany({ where: { platform: PLATFORM } }).then((r) => r.count),
    ],
  ];
  for (const [label, count, del] of wipes) {
    const n = APPLY ? await del() : await count();
    console.log(`  ${APPLY ? '✓ deleted' : '· would delete'} ${String(n).padStart(4)}  ${label}`);
  }
  console.log('');

  // ── 3. Ensure each ZooKeeper Group / GroupLevel backing znode exists ──────────
  console.log(`Step 3/3 — Ensuring backing znodes exist on the ensemble${APPLY ? '' : ' (preview)'}…`);
  const byPath = await collectBackingPaths();
  if (byPath.size === 0) {
    console.log('  · No ZooKeeper groups/levels with a backing path found — nothing to create.');
  }
  let created = 0;
  let present = 0;
  for (const [path, owners] of [...byPath.entries()].sort()) {
    const exists = await zookeeperService.exists(path);
    const who = `(${[...new Set(owners)].join(', ')})`;
    if (exists) {
      present++;
      console.log(`  · exists        ${path.padEnd(36)} ${who}`);
      continue;
    }
    if (APPLY) {
      await zookeeperService.createNodeRecursive(path);
      console.log(`  ✓ created       ${path.padEnd(36)} ${who}`);
    } else {
      console.log(`  · would create  ${path.padEnd(36)} ${who}`);
    }
    created++;
  }
  console.log('');
  console.log(`  ${APPLY ? 'Created' : 'Would create'} ${created} znode(s); ${present} already present.`);
  console.log('');

  // ── Heads-up: existing ZooKeeper grants need re-provisioning ──────────────────
  const activeZkGrants = await prisma.userAccess.count({
    where: { isActive: true, group: { platform: PLATFORM } },
  });
  if (activeZkGrants > 0) {
    console.log(`  ⚠ ${activeZkGrants} active ZooKeeper grant(s) remain in the DB, but their sim`);
    console.log('    credentials were just cleared. Holders have no ACL on the live ensemble until');
    console.log('    they are re-provisioned — revoke + re-grant them, or have them re-request access.');
    console.log('');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (APPLY) {
    console.log('  Done. Restart the backend (`npm run dev`) to begin exercising the');
    console.log('  live flow against the real ensemble.');
  } else {
    console.log('  DRY RUN complete — nothing was changed. Re-run with --apply to execute:');
    console.log('    npx ts-node scripts/reset-for-live-zookeeper.ts --apply');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch((err) => {
    console.error('Reset failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    zookeeperService.close();
    await prisma.$disconnect();
  });
