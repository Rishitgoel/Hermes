-- AlterTable: requester-selected manifest files for the infra-deployment PR
ALTER TABLE "secret_ingestion_requests" ADD COLUMN     "infra_targets" JSONB;
