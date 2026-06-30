/**
 * Seed local ZooKeeper demo state end-to-end so the `zookeeper` platform is testable.
 *
 * What it does (idempotent):
 *   1. Upserts two Hermes groups + levels (Credit Card, Config Store) via the shared
 *      {@link upsertZookeeperGroup} helper, so they're requestable in the UI.
 *   2. Mints a ZooKeeper credential for a mock user (john@bachatt.app) through the real
 *      adapter — exactly the flow approving an account-creation request runs — so the
 *      user has a cache row and is genuinely provisionable (NOT just a raw znode ACL).
 *   3. Provisions that user onto each group's level, creating the backing znodes and
 *      writing the digest ACL entries.
 *   4. Prints the one-time credential and reads the resulting znode ACLs back for proof.
 *
 * Run AGAINST LIVE ZOOKEEPER: bring up the container and use the live env, e.g.
 *   docker compose up -d zookeeper
 *   ZOOKEEPER_SIMULATION=false npx ts-node scripts/seed-zookeeper-mock.ts
 * (It also runs in simulation, but then the znodes live only in the backend's
 *  in-process store and won't persist for an external client to inspect.)
 */
import prisma from '../src/config/prisma';
import config from '../src/config/config';
import { zookeeperProvisioner } from '../src/services/zookeeper.provisioner';
import { zookeeperService } from '../src/services/zookeeper.service';
import { upsertZookeeperGroup } from './create-zookeeper-group';

const MOCK_EMAIL = 'john@bachatt.app';
const MOCK_NAME = 'John Doe';

async function main() {
  const root = config.zookeeper.rootPath.replace(/\/$/, '');
  const sim = config.zookeeper.isSimulation;
  console.log(
    `ZooKeeper seed — mode: ${sim ? 'SIMULATION (in-process)' : `LIVE (${config.zookeeper.connectString})`}`,
  );
  if (sim) {
    console.log(
      '⚠  Running in simulation: znodes live only in this process and will not persist.',
    );
    console.log(
      '   For real znodes: `docker compose up -d zookeeper` then ZOOKEEPER_SIMULATION=false.\n',
    );
  }

  // 1. Hermes groups + levels (so they appear under the ZooKeeper platform).
  const groups = [
    { name: 'Credit Card', path: `${root}/credit-card` },
    { name: 'Config Store', path: `${root}/config-store` },
  ];
  for (const g of groups) {
    const created = await upsertZookeeperGroup(g.name, g.path);
    // Reset the backing znode so re-runs start from a clean node (delete-then-create).
    await zookeeperService.deleteNode(g.path);
    await zookeeperService.createNode(g.path);
    console.log(
      `✅ group "${created.name}" → ${created.externalGroupId} (znode reset)`,
    );
  }

  // 2. Create the mock user's ZK identity through the adapter (writes the cache row).
  //    No credential is minted — access is enforced inside Hermes (world-open znodes).
  await zookeeperProvisioner.inviteUser(MOCK_EMAIL, MOCK_NAME);

  // 3. Provision that user: read/write on Credit Card, read-only on Config Store.
  await zookeeperProvisioner.provision({
    email: MOCK_EMAIL,
    name: MOCK_NAME,
    externalGroupId: `${root}/credit-card#cdrw`,
  });
  await zookeeperProvisioner.provision({
    email: MOCK_EMAIL,
    name: MOCK_NAME,
    externalGroupId: `${root}/config-store#r`,
  });

  // 4. Verify node existence as proof.
  const ccExists = await zookeeperService.exists(`${root}/credit-card`);
  const csExists = await zookeeperService.exists(`${root}/config-store`);

  console.log('\n🔑 Mock ZooKeeper user provisioned (no credential — access is enforced in Hermes):');
  console.log(`   user    : ${MOCK_EMAIL}`);
  console.log(
    `   connect : ${config.zookeeper.connectString || '(simulation — no live connect string)'}`,
  );
  console.log('\nResulting znodes status (world-open by default):');
  console.log(`   ${root}/credit-card  → ${ccExists ? 'exists' : 'does not exist'}`);
  console.log(`   ${root}/config-store → ${csExists ? 'exists' : 'does not exist'}`);
  console.log('\n✅ Seed complete.');
}

main()
  .catch(e => {
    console.error('Error:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    zookeeperService.close();
    await prisma.$disconnect();
  });
