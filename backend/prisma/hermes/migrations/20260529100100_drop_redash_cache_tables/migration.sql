-- Cutover complete: all code now reads/writes the generic platform_external_*
-- tables. Drop the Redash-specific cache tables and the "redash" default on
-- groups.platform (platform is now a required, explicit field).

-- AlterTable
ALTER TABLE "groups" ALTER COLUMN "platform" DROP DEFAULT;

-- DropTable
DROP TABLE "redash_users";

-- DropTable
DROP TABLE "redash_groups";
