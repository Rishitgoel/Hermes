-- AlterTable: tag each Secret Ingestion request with its instance (AWS account).
-- Existing rows default to "secrets" (prod + QA); "secrets-sandbox" is the second account.
ALTER TABLE "secret_ingestion_requests" ADD COLUMN     "platform" TEXT NOT NULL DEFAULT 'secrets';

-- CreateIndex
CREATE INDEX "secret_ingestion_requests_platform_idx" ON "secret_ingestion_requests"("platform");
