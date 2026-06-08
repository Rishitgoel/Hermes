-- DropIndex
DROP INDEX "user_creation_requests_user_email_key";

-- DropIndex
DROP INDEX "user_creation_requests_user_id_key";

-- AlterTable
ALTER TABLE "user_creation_requests" ADD COLUMN     "platform" TEXT NOT NULL DEFAULT 'redash',
ALTER COLUMN "external_user_id" SET DATA TYPE TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "user_creation_requests_user_id_platform_key" ON "user_creation_requests"("user_id", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "user_creation_requests_user_email_platform_key" ON "user_creation_requests"("user_email", "platform");

