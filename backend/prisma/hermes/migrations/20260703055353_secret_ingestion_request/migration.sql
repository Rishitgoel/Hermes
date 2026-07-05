-- CreateEnum
CREATE TYPE "SecretIngestionStatus" AS ENUM ('PENDING', 'APPLYING', 'APPLIED', 'PARTIALLY_APPLIED', 'APPLY_FAILED', 'REJECTED');

-- CreateTable
CREATE TABLE "secret_ingestion_requests" (
    "id" TEXT NOT NULL,
    "requester_id" TEXT NOT NULL,
    "requester_name" TEXT NOT NULL,
    "requester_email" TEXT NOT NULL,
    "group_id" TEXT,
    "secret_name" TEXT NOT NULL,
    "entries" JSONB NOT NULL,
    "justification" TEXT,
    "reviewer_id" TEXT,
    "reviewer_name" TEXT,
    "review_note" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "apply_error" TEXT,
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "status" "SecretIngestionStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "secret_ingestion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "secret_ingestion_requests_status_idx" ON "secret_ingestion_requests"("status");

-- CreateIndex
CREATE INDEX "secret_ingestion_requests_requester_id_idx" ON "secret_ingestion_requests"("requester_id");

-- CreateIndex
CREATE INDEX "secret_ingestion_requests_group_id_idx" ON "secret_ingestion_requests"("group_id");

-- AddForeignKey
ALTER TABLE "secret_ingestion_requests" ADD CONSTRAINT "secret_ingestion_requests_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
