import config from '../config/config';
import zookeeperService from './zookeeper.service';
import { ConflictError } from '../utils/errors';
import logger from '../utils/logger';

export interface ZookeeperMigrationReport {
  apply: boolean;
  targetRoots: string[];
  pathsFound: string[];
  updatedCount: number;
  failedPaths: { path: string; error: string }[];
}

/** Robust recursive function to collect all child paths, catching and logging read errors to avoid crashing the whole process */
async function collectPathsRobustly(rootPath: string): Promise<string[]> {
  const collected: string[] = [];
  try {
    const exists = await zookeeperService.exists(rootPath);
    if (!exists) {return [];}
    collected.push(rootPath);
  } catch (err: any) {
    logger.warn({ path: rootPath, error: err.message }, 'Skipping root path migration due to exists check error');
    return [];
  }

  const walk = async (p: string): Promise<void> => {
    let children: string[] = [];
    try {
      children = await zookeeperService.getChildren(p);
    } catch (err: any) {
      logger.warn({ path: p, error: err.message }, 'Skipping child znode scanning due to read/permission error');
      return;
    }

    for (const c of children) {
      const childPath = p === '/' ? `/${c}` : `${p}/${c}`;
      if (zookeeperService.isReservedPath(childPath)) {continue;}
      collected.push(childPath);
      await walk(childPath);
    }
  };

  await walk(rootPath);
  return collected;
}

export async function migrateZookeeperAcls(opts: {
  apply: boolean;
  performerId: string;
  performerName: string;
}): Promise<ZookeeperMigrationReport> {
  const { apply } = opts;

  if (config.zookeeper.isSimulation) {
    throw new ConflictError('Cannot migrate ZooKeeper ACLs in simulation mode.');
  }

  // 1. Verify ZooKeeper connection
  const health = await zookeeperService.healthCheck();
  if (!health.healthy) {
    throw new ConflictError(`Could not reach ZooKeeper: ${health.message ?? 'unknown error'}`);
  }

  // 2. Scan the Hermes-managed tree from config.zookeeper.rootPath (default "/", the whole
  //    ensemble), skipping the reserved /zookeeper subtree. Nodes outside the root are never
  //    touched. collectPathsRobustly already excludes reserved paths internally.
  const pathsToUpdate: string[] = [];
  const allPaths = await collectPathsRobustly(config.zookeeper.rootPath);
  pathsToUpdate.push(...allPaths);

  const uniquePaths = Array.from(new Set(pathsToUpdate)).sort();
  const failedPaths: { path: string; error: string }[] = [];
  let updatedCount = 0;

  // 4. Perform update if apply === true
  for (const path of uniquePaths) {
    if (apply) {
      try {
        await zookeeperService.setWorldOpenAcl(path);
        updatedCount++;
      } catch (err: any) {
        failedPaths.push({ path, error: err.message });
        logger.error({ path, error: err.message }, 'Failed to set world-open ACL on znode');
      }
    }
  }

  return {
    apply,
    targetRoots: [config.zookeeper.rootPath],
    pathsFound: uniquePaths,
    updatedCount,
    failedPaths,
  };
}
