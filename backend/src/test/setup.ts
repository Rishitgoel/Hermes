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
process.env.ZOOKEEPER_SIMULATION = 'true';
process.env.EMAIL_SIMULATION = 'true';
process.env.SLACK_SIMULATION = 'true';
process.env.SECRETS_INGESTION_SIMULATION = 'true';
process.env.INFRA_REPO_SIMULATION = 'true';
process.env.NODE_ENV = 'test';

// 2. Provision the schema on the EPHEMERAL test database only.
//    `db push` is used here purely for the throwaway Testcontainer — it is NEVER run
//    against QA/prod (those are provisioned by hand from prisma/hermes/manual-schema.sql;
//    nothing in the deploy path migrates). Hard-guard: refuse to touch anything that is
//    not the local container, so a stray DATABASE_URL_HERMES in the env can't nuke a real DB.
if (!/@(localhost|127\.0\.0\.1)(:|\/)/.test(uri)) {
  console.error(`Refusing to run schema setup against a non-local database: ${uri}`);
  await container.stop();
  process.exit(1);
}
try {
  execSync('npx prisma db push --schema=prisma/hermes/schema.prisma --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL_HERMES: uri },
    stdio: 'inherit',
  });
} catch (err) {
  console.error('Failed to provision the ephemeral test database:', err);
  await container.stop();
  process.exit(1);
}

// 3. Dynamically import the Prisma Client so it initializes with the Testcontainer connection string
const { default: prisma } = await import('../config/prisma');

// 4. Create custom partial unique indexes that prisma db push misses (as they are SQL-only migrations)
try {
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "user_accesses_user_id_group_id_active_unique"
    ON "user_accesses" ("user_id", "group_id")
    WHERE "is_active" = true;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "access_requests_requester_group_open_unique"
    ON "access_requests" ("requester_id", "group_id")
    WHERE "status" IN ('PENDING', 'WAITING_FOR_SETUP');
  `);
} catch (err) {
  console.error('Failed to create custom partial unique indexes on the test database:', err);
  await container.stop();
  process.exit(1);
}

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
      "secret_ingestion_requests", 
      "group_levels", 
      "groups" 
    CASCADE;
  `);
});
