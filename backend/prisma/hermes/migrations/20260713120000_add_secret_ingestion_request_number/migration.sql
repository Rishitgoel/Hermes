-- AlterTable: add a human-friendly, monotonically increasing handle (shown as "#12" in the UI).
-- SERIAL backfills every existing row with a distinct sequence value, so NOT NULL + the unique
-- index below both hold for pre-existing requests. Global across instances (the platform badge
-- already distinguishes AWS accounts).
ALTER TABLE "secret_ingestion_requests" ADD COLUMN     "request_number" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "secret_ingestion_requests_request_number_key" ON "secret_ingestion_requests"("request_number");
