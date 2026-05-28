-- CreateEnum
CREATE TYPE "UserCreationStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'AWAITING_SETUP', 'COMPLETED');

-- AlterEnum
ALTER TYPE "RequestStatus" ADD VALUE 'WAITING_FOR_SETUP';

-- CreateTable
CREATE TABLE "user_creation_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_name" TEXT NOT NULL,
    "user_email" TEXT NOT NULL,
    "justification" TEXT,
    "status" "UserCreationStatus" NOT NULL DEFAULT 'DRAFT',
    "reviewer_id" TEXT,
    "reviewer_name" TEXT,
    "review_note" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "invite_sent_at" TIMESTAMP(3),
    "invite_error" TEXT,
    "completed_at" TIMESTAMP(3),
    "external_user_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_creation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_creation_requests_user_id_key" ON "user_creation_requests"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_creation_requests_user_email_key" ON "user_creation_requests"("user_email");

-- CreateIndex
CREATE INDEX "user_creation_requests_status_idx" ON "user_creation_requests"("status");

-- CreateIndex
CREATE INDEX "user_creation_requests_user_email_idx" ON "user_creation_requests"("user_email");
