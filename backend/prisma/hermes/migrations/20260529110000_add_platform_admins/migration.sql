-- Platform-scoped admin tier (between hermes_super_admin and group_admin).
-- Mirrors the Keycloak `hermes_platform_admin_<platform>` role assignments so
-- Hermes can list admins, fan out notifications, and authorize cheaply (and
-- function in simulation mode where Keycloak isn't running).

-- CreateTable
CREATE TABLE "platform_admins" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_name" TEXT NOT NULL,
    "user_email" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" TEXT NOT NULL,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_admins_platform_idx" ON "platform_admins"("platform");

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_user_id_platform_key" ON "platform_admins"("user_id", "platform");
