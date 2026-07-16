-- AlterTable
ALTER TABLE "secret_ingestion_requests" ADD COLUMN     "batch_id" TEXT;

-- CreateIndex
CREATE INDEX "secret_ingestion_requests_batch_id_idx" ON "secret_ingestion_requests"("batch_id");
