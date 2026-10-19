-- CreateEnum
CREATE TYPE "SetupVerification" AS ENUM ('EMPLOYEE_CONFIRMATION', 'MANAGEMENT_VERIFICATION', 'MANAGEMENT_ONLY');

-- CreateEnum
CREATE TYPE "SetupAudience" AS ENUM ('ALL_EMPLOYEES', 'ROLES', 'SPECIFIC');

-- AlterTable
ALTER TABLE "EmployeeSetupItem" ADD COLUMN     "employeeConfirmedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SetupRequirement" ADD COLUMN     "audience" "SetupAudience" NOT NULL DEFAULT 'ALL_EMPLOYEES',
ADD COLUMN     "category" TEXT,
ADD COLUMN     "verification" "SetupVerification" NOT NULL DEFAULT 'MANAGEMENT_VERIFICATION';

-- CreateTable
CREATE TABLE "SetupRequirementTarget" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "profileId" TEXT,
    "teamId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SetupRequirementTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SetupRequirementTarget_profileId_idx" ON "SetupRequirementTarget"("profileId");

-- CreateIndex
CREATE INDEX "SetupRequirementTarget_teamId_idx" ON "SetupRequirementTarget"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "SetupRequirementTarget_requirementId_profileId_key" ON "SetupRequirementTarget"("requirementId", "profileId");

-- CreateIndex
CREATE UNIQUE INDEX "SetupRequirementTarget_requirementId_teamId_key" ON "SetupRequirementTarget"("requirementId", "teamId");

-- AddForeignKey
ALTER TABLE "SetupRequirementTarget" ADD CONSTRAINT "SetupRequirementTarget_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "SetupRequirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupRequirementTarget" ADD CONSTRAINT "SetupRequirementTarget_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupRequirementTarget" ADD CONSTRAINT "SetupRequirementTarget_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing role-limited requirements keep their audience.
UPDATE "SetupRequirement" SET "audience" = 'ROLES' WHERE "rolesJson" IS NOT NULL;

