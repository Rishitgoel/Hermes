-- The 20260525114124_init migration created a GLOBAL unique index on
-- groups.name, but the schema declares @@unique([platform, name]) and no
-- migration ever made the switch. Replace the global index with the composite
-- one so two platforms (e.g. AWS and Redash) can each have a group with the
-- same name — required by the platform-sync group reconciliation.
DROP INDEX IF EXISTS "groups_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "groups_platform_name_key" ON "groups"("platform", "name");
