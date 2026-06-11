import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'child_process';
import { afterAll, beforeEach } from 'vitest';

// 1. Start the ephemeral Postgres container and set the connection env var FIRST
const container = await new PostgreSqlContainer('postgres:15-alpine').start();
const uri = container.getConnectionUri();

process.env.DATABASE_URL_HERMES = uri;
process.env.KEYCLOAK_SIMULATION = 'true';
process.env.REDASH_SIMULATION = 'true';
process.env.AWS_SIMULATION = 'true';
process.env.EMAIL_SIMULATION = 'true';
process.env.SLACK_SIMULATION = 'true';
process.env.NODE_ENV = 'test';

// 2. Run migrations on the test database
try {
  execSync('npx prisma migrate deploy --schema=prisma/hermes/schema.prisma', {
    env: { ...process.env, DATABASE_URL_HERMES: uri },
    stdio: 'inherit',
  });
} catch (err) {
  console.error('Failed to run Prisma migrations on the ephemeral test database:', err);
  await container.stop();
  process.exit(1);
}

// 3. Dynamically import the Prisma Client so it initializes with the Testcontainer connection string
const { default: prisma } = await import('../config/prisma');

// Global hooks
afterAll(async () => {
  if (prisma) {
    await prisma.$disconnect();
  }
  if (container) {
    await container.stop();
  }
});

beforeEach(async () => {
  // Clear tables in one atomic statement to prevent FK constraint violations
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE 
      "audit_entries", 
      "notifications", 
      "user_accesses", 
      "access_requests", 
      "group_admins", 
      "platform_admins", 
      "user_creation_requests", 
      "platform_external_users", 
      "platform_external_groups", 
      "group_levels", 
      "groups" 
    CASCADE;
  `);
});
