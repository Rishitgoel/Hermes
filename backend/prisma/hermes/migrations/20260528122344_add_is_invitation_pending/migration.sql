-- AlterTable
ALTER TABLE "redash_users" ADD COLUMN     "is_invitation_pending" BOOLEAN NOT NULL DEFAULT false;
