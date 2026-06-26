-- AlterEnum
ALTER TYPE "ZkChangeStatus" ADD VALUE 'PARTIALLY_APPLIED';

-- AlterTable
ALTER TABLE "zookeeper_change_requests" ADD COLUMN     "group_ids" TEXT[];
