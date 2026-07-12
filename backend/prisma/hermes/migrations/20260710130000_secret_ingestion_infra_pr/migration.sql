-- AlterTable: track the infra-deployment GitHub PR that mirrors each secret ingestion request
ALTER TABLE "secret_ingestion_requests" ADD COLUMN     "infra_pr_number" INTEGER;
ALTER TABLE "secret_ingestion_requests" ADD COLUMN     "infra_pr_url" TEXT;
ALTER TABLE "secret_ingestion_requests" ADD COLUMN     "infra_pr_node_id" TEXT;
ALTER TABLE "secret_ingestion_requests" ADD COLUMN     "infra_branch" TEXT;
ALTER TABLE "secret_ingestion_requests" ADD COLUMN     "infra_sync_state" TEXT;
ALTER TABLE "secret_ingestion_requests" ADD COLUMN     "infra_sync_note" TEXT;
