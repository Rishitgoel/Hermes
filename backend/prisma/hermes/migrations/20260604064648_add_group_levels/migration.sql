-- AlterTable
ALTER TABLE "access_requests" ADD COLUMN     "level_id" TEXT;

-- AlterTable
ALTER TABLE "user_accesses" ADD COLUMN     "level_id" TEXT;

-- CreateTable
CREATE TABLE "group_levels" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "permission" TEXT,
    "external_group_id" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_levels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_levels_group_id_idx" ON "group_levels"("group_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_levels_group_id_slug_key" ON "group_levels"("group_id", "slug");

-- CreateIndex
CREATE INDEX "access_requests_level_id_idx" ON "access_requests"("level_id");

-- CreateIndex
CREATE INDEX "user_accesses_level_id_idx" ON "user_accesses"("level_id");

-- AddForeignKey
ALTER TABLE "group_levels" ADD CONSTRAINT "group_levels_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "group_levels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_accesses" ADD CONSTRAINT "user_accesses_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "group_levels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
