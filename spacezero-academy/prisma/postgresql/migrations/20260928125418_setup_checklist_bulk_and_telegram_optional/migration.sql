-- AlterTable
ALTER TABLE "SetupRequirement" ADD COLUMN "allowPersonalAccount" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "EmployeeSetupItem" ADD COLUMN "accountType" TEXT;
