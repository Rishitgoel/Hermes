-- CreateEnum
CREATE TYPE "ZkChangeStatus" AS ENUM ('PENDING', 'APPLYING', 'APPLIED', 'APPLY_FAILED', 'REJECTED');

-- CreateTable
CREATE TABLE "zookeeper_change_requests" (
    "id" TEXT NOT NULL,
    "requester_id" TEXT NOT NULL,
    "requester_name" TEXT NOT NULL,
    "requester_email" TEXT NOT NULL,
    "group_id" TEXT,
    "status" "ZkChangeStatus" NOT NULL DEFAULT 'PENDING',
    "changes" JSONB NOT NULL,
    "justification" TEXT,
    "reviewer_id" TEXT,
    "reviewer_name" TEXT,
    "review_note" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "apply_error" TEXT,
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zookeeper_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "zookeeper_change_requests_status_idx" ON "zookeeper_change_requests"("status");

-- CreateIndex
CREATE INDEX "zookeeper_change_requests_requester_id_idx" ON "zookeeper_change_requests"("requester_id");

-- CreateIndex
CREATE INDEX "zookeeper_change_requests_group_id_idx" ON "zookeeper_change_requests"("group_id");

-- AddForeignKey
ALTER TABLE "zookeeper_change_requests" ADD CONSTRAINT "zookeeper_change_requests_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
