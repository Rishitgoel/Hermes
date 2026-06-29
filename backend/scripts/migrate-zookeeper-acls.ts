/**
 * One-shot migration script to recursively set the ACL of the ZooKeeper paths
 * (/hermes, /bachatt, and any configured root path) and all their descendants
 * to world-open (world:anyone, ALL permissions) without deleting any znodes
 * or modifying their data.
 *
 * This is crucial for production, where you want to switch to the no-ACL model
 * but cannot afford to lose existing data.
 *
 * Usage (from backend/):
 *   npx ts-node scripts/migrate-zookeeper-acls.ts            # DRY RUN — prints the paths to be updated
 *   npx ts-node scripts/migrate-zookeeper-acls.ts --apply    # executes the update
 *
 * Requires:
 *   ZOOKEEPER_SIMULATION=false, ZOOKEEPER_CONNECT_STRING, ZOOKEEPER_ADMIN_AUTH ("user:password")
 */

import config from '../src/config/config';
import zookeeperService from '../src/services/zookeeper.service';

const APPLY = process.argv.includes('--apply');

/** Robust recursive function to collect all child paths, catching and logging read errors to avoid crashing the whole process */
async function collectPathsRobustly(rootPath: string): Promise<string[]> {
  const collected: string[] = [];
  try {
    const exists = await zookeeperService.exists(rootPath);
    if (!exists) return [];
    collected.push(rootPath);
  } catch (err: any) {
    console.warn(`  ⚠ Skipping root path ${rootPath} due to exists check error: ${err.message}`);
    return [];
  }

  const walk = async (p: string): Promise<void> => {
    let children: string[] = [];
    try {
      children = await zookeeperService.getChildren(p);
    } catch (err: any) {
      console.warn(`  ⚠ Skipping child scanning for ${p} due to read/permission error: ${err.message}`);
      return;
    }

    for (const c of children) {
      const childPath = p === '/' ? `/${c}` : `${p}/${c}`;
      if (zookeeperService.isReservedPath(childPath)) continue;
      collected.push(childPath);
      await walk(childPath);
    }
  };

  await walk(rootPath);
  return collected;
}

async function main() {
  // Scan the entire ZooKeeper tree from / (skipping the reserved /zookeeper subtree).
  // collectPathsRobustly already excludes reserved paths internally.

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Hermes ZK ACL Migration   [${APPLY ? 'APPLY' : 'DRY RUN'}]`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Connect:    ${config.zookeeper.connectString || '(unset)'}`);
  console.log(`  Target Root: /`);
  console.log(`  Mode:       ${config.zookeeper.isSimulation ? 'SIMULATION' : 'LIVE'}`);
  console.log('');

  if (config.zookeeper.isSimulation) {
    console.error(
      '✗ Refusing to run: ZooKeeper is in simulation mode. Set ZOOKEEPER_SIMULATION=false\n' +
        '  and a real ZOOKEEPER_CONNECT_STRING + ZOOKEEPER_ADMIN_AUTH in backend/.env first.'
    );
    process.exit(1);
  }

  // 1. Verify ZooKeeper connection
  console.log('Step 1/2 — Verifying the ZooKeeper ensemble is reachable…');
  const health = await zookeeperService.healthCheck();
  if (!health.healthy) {
    console.error(`✗ Could not reach ZooKeeper: ${health.message ?? 'unknown error'}`);
    console.error('  Nothing was changed. Fix connection variables and retry.');
    process.exit(1);
  }
  console.log('  ✓ Ensemble reachable and admin digest authenticated.');
  console.log('');

  // 2. Collect all paths from / robustly
  console.log('Step 2/2 — Collecting znodes under /…');
  const pathsToUpdate = await collectPathsRobustly('/');

  // Deduplicate collected paths just in case they overlap
  const uniquePaths = Array.from(new Set(pathsToUpdate)).sort();

  if (uniquePaths.length === 0) {
    console.log('  ⚠ No paths found to migrate under the target roots.');
    process.exit(0);
  }

  console.log(`  Found ${uniquePaths.length} unique paths to update.`);
  console.log('');

  // 3. Update ACLs
  let updatedCount = 0;
  for (const path of uniquePaths) {
    if (APPLY) {
      try {
        await zookeeperService.setWorldOpenAcl(path);
        console.log(`  ✓ Updated ACL    ${path}`);
        updatedCount++;
      } catch (err: any) {
        console.error(`  ✗ Failed to update ACL for ${path}: ${err.message}`);
      }
    } else {
      console.log(`  · Would update ACL    ${path}`);
    }
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (APPLY) {
    console.log(`  Done. Successfully migrated ACLs for ${updatedCount}/${uniquePaths.length} znodes.`);
  } else {
    console.log('  DRY RUN complete — no ACLs were changed. Re-run with --apply to execute:');
    console.log('    npx ts-node scripts/migrate-zookeeper-acls.ts --apply');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  })
  .finally(() => {
    zookeeperService.close();
  });
