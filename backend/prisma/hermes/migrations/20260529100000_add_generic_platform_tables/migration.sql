-- Generic, platform-keyed cache tables that replace the Redash-specific
-- redash_users / redash_groups tables. This migration only CREATES and
-- BACKFILLS; the old tables are dropped in a later migration so a rolling
-- deploy can still read them until every node runs the new code.

-- CreateTable
CREATE TABLE "platform_external_users" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_disabled" BOOLEAN NOT NULL DEFAULT false,
    "is_pending" BOOLEAN NOT NULL DEFAULT false,
    "external_group_ids" TEXT[],
    "metadata" JSONB,
    "last_synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_external_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_external_groups" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "member_count" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "last_synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_external_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_external_users_platform_external_id_key" ON "platform_external_users"("platform", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_external_users_platform_email_key" ON "platform_external_users"("platform", "email");

-- CreateIndex
CREATE INDEX "platform_external_users_platform_email_idx" ON "platform_external_users"("platform", "email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_external_groups_platform_external_id_key" ON "platform_external_groups"("platform", "external_id");

-- CreateIndex
CREATE INDEX "platform_external_groups_platform_idx" ON "platform_external_groups"("platform");

-- Backfill existing Redash cache rows into the generic tables.
-- group_ids (int[]) is preserved both as string[] (external_group_ids) and in
-- metadata.groupIds for any consumer that still wants the original integers.
INSERT INTO "platform_external_users"
    ("id", "platform", "external_id", "email", "name", "is_disabled", "is_pending", "external_group_ids", "metadata", "last_synced_at", "created_at")
SELECT
    gen_random_uuid(),
    'redash',
    "id"::text,
    "email",
    "name",
    "is_disabled",
    "is_invitation_pending",
    ARRAY(SELECT unnest("group_ids")::text),
    jsonb_build_object('groupIds', to_jsonb("group_ids")),
    "last_synced_at",
    "created_at"
FROM "redash_users";

INSERT INTO "platform_external_groups"
    ("id", "platform", "external_id", "name", "type", "member_count", "metadata", "last_synced_at", "created_at")
SELECT
    gen_random_uuid(),
    'redash',
    "id"::text,
    "name",
    "type",
    "member_count",
    NULL,
    "last_synced_at",
    "created_at"
FROM "redash_groups";
