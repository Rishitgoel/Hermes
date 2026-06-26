import { loadSecrets } from '../src/config/secrets';
import syncService from '../src/services/sync.service';
import prisma from '../src/config/prisma';

async function main() {
  console.log('🔄 Loading secrets...');
  await loadSecrets();

  console.log('🔄 Triggering sync across all platforms...');
  const result = await syncService.syncAllPlatforms();
  console.log('✅ Sync completed successfully!');
  console.log(`   - Users Synced: ${result.usersSynced}`);
  console.log(`   - Groups Synced: ${result.groupsSynced}`);
}

main()
  .catch((err) => {
    console.error('❌ Sync failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log('🔌 Prisma client disconnected.');
  });
