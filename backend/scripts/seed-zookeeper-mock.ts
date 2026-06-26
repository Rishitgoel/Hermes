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
  console.log(`ZooKeeper seed — mode: ${sim ? 'SIMULATION (in-process)' : `LIVE (${config.zookeeper.connectString})`}`);
  if (sim) {
    console.log('⚠  Running in simulation: znodes live only in this process and will not persist.');
    console.log('   For real znodes: `docker compose up -d zookeeper` then ZOOKEEPER_SIMULATION=false.\n');
  }

  // 1. Hermes groups + levels (so they appear under the ZooKeeper platform).
  const groups = [
    { name: 'Credit Card', path: `${root}/credit-card` },
    { name: 'Config Store', path: `${root}/config-store` },
  ];
  for (const g of groups) {
    const created = await upsertZookeeperGroup(g.name, g.path);
    // Reset the backing znode so re-runs don't accumulate stale ACL entries: a real
    // account is invited once, but this mock re-mints a fresh credential (new hash)
    // every run, so delete-then-create keeps a single, clean entry per node.
    await zookeeperService.deleteNode(g.path);
    await zookeeperService.createNode(g.path);
    console.log(`✅ group "${created.name}" → ${created.externalGroupId} (znode reset)`);
  }

  // 2. Mint the mock user's credential through the adapter (writes the cache row).
  const invite = await zookeeperProvisioner.inviteUser(MOCK_EMAIL, MOCK_NAME);
  const username = invite.metadata?.zkUsername as string;
  const password = invite.metadata?.zkPassword as string;

  // 3. Provision that user: read/write on Credit Card, read-only on Config Store.
  await zookeeperProvisioner.provision({ email: MOCK_EMAIL, name: MOCK_NAME, externalGroupId: `${root}/credit-card#cdrw` });
  await zookeeperProvisioner.provision({ email: MOCK_EMAIL, name: MOCK_NAME, externalGroupId: `${root}/config-store#r` });

  // 4. Read the ACLs back as proof.
  const ccAcl = await zookeeperService.getAcl(`${root}/credit-card`);
  const csAcl = await zookeeperService.getAcl(`${root}/config-store`);

  console.log('\n🔑 Mock ZooKeeper credential (shown once — store it to test live auth):');
  console.log(`   connect : ${config.zookeeper.connectString || '(simulation — no live connect string)'}`);
  console.log(`   username: ${username}`);
  console.log(`   password: ${password}`);
  console.log(`   addauth : addauth digest ${username}:${password}`);
  console.log('\nResulting znode ACLs (Hermes-managed digest entries):');
  console.log(`   ${root}/credit-card  →`, ccAcl.map((e) => `${e.id} (${e.perms})`));
  console.log(`   ${root}/config-store →`, csAcl.map((e) => `${e.id} (${e.perms})`));
  console.log('\n✅ Seed complete.');
}

main()
  .catch((e) => {
    console.error('Error:', e?.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    zookeeperService.close();
    await prisma.$disconnect();
  });
