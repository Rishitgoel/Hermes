-- AlterTable
ALTER TABLE "user_accesses" ADD COLUMN     "expiry_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_expiry_error" TEXT;
