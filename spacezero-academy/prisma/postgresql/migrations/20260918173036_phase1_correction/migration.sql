-- CreateEnum
CREATE TYPE "SetupItemStatus" AS ENUM ('NOT_SET_UP', 'IN_PROGRESS', 'COMPLETED', 'ISSUE', 'NOT_REQUIRED');

-- CreateEnum
CREATE TYPE "SetupRequirementKind" AS ENUM ('MANUAL', 'LOCAL_PHONE', 'ADDRESS', 'CREDENTIAL_VAULT');

-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('VACATION', 'SICK', 'PERSONAL', 'UNPAID', 'OTHER');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LeaveRecommendation" AS ENUM ('NONE', 'RECOMMEND_APPROVE', 'RECOMMEND_REJECT');

-- CreateEnum
CREATE TYPE "TrainingAssignPolicy" AS ENUM ('ADMIN_ONLY', 'SELECTED_SUPERVISORS', 'ALL_SUPERVISORS');

-- AlterEnum
ALTER TYPE "LibraryItemType" ADD VALUE 'AUDIO';

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "currentAddressEnc" TEXT,
ADD COLUMN     "localPhone" TEXT;

-- AlterTable
ALTER TABLE "TrainingCourse" ADD COLUMN     "assignPolicy" "TrainingAssignPolicy" NOT NULL DEFAULT 'ADMIN_ONLY';

-- CreateTable
CREATE TABLE "SetupRequirement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "kind" "SetupRequirementKind" NOT NULL DEFAULT 'MANUAL',
    "rolesJson" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "companyControlled" BOOLEAN NOT NULL DEFAULT false,
    "credentialSystem" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SetupRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeSetupItem" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "status" "SetupItemStatus" NOT NULL DEFAULT 'NOT_SET_UP',
    "companyControlConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeSetupItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "systemKey" TEXT,
    "payloadEnc" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CredentialGrant" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "granteeId" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CredentialGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "teamId" TEXT,
    "supervisorId" TEXT,
    "leaveType" "LeaveType" NOT NULL DEFAULT 'VACATION',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "days" INTEGER NOT NULL,
    "note" TEXT,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "recommendation" "LeaveRecommendation" NOT NULL DEFAULT 'NONE',
    "supervisorNote" TEXT,
    "supervisorReviewedById" TEXT,
    "supervisorReviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "managementNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgSetting" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueJson" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingAssignGrant" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "supervisorId" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingAssignGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SetupRequirement_organizationId_idx" ON "SetupRequirement"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "SetupRequirement_organizationId_key_key" ON "SetupRequirement"("organizationId", "key");

-- CreateIndex
CREATE INDEX "EmployeeSetupItem_requirementId_idx" ON "EmployeeSetupItem"("requirementId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeSetupItem_profileId_requirementId_key" ON "EmployeeSetupItem"("profileId", "requirementId");

-- CreateIndex
CREATE INDEX "Credential_ownerId_idx" ON "Credential"("ownerId");

-- CreateIndex
CREATE INDEX "Credential_organizationId_idx" ON "Credential"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CredentialGrant_ownerId_granteeId_key" ON "CredentialGrant"("ownerId", "granteeId");

-- CreateIndex
CREATE INDEX "LeaveRequest_organizationId_status_idx" ON "LeaveRequest"("organizationId", "status");

-- CreateIndex
CREATE INDEX "LeaveRequest_profileId_idx" ON "LeaveRequest"("profileId");

-- CreateIndex
CREATE INDEX "LeaveRequest_teamId_idx" ON "LeaveRequest"("teamId");

-- CreateIndex
CREATE INDEX "LeaveRequest_supervisorId_idx" ON "LeaveRequest"("supervisorId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgSetting_organizationId_key_key" ON "OrgSetting"("organizationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAssignGrant_courseId_supervisorId_key" ON "TrainingAssignGrant"("courseId", "supervisorId");

-- AddForeignKey
ALTER TABLE "SetupRequirement" ADD CONSTRAINT "SetupRequirement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSetupItem" ADD CONSTRAINT "EmployeeSetupItem_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSetupItem" ADD CONSTRAINT "EmployeeSetupItem_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "SetupRequirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSetupItem" ADD CONSTRAINT "EmployeeSetupItem_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialGrant" ADD CONSTRAINT "CredentialGrant_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialGrant" ADD CONSTRAINT "CredentialGrant_granteeId_fkey" FOREIGN KEY ("granteeId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgSetting" ADD CONSTRAINT "OrgSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAssignGrant" ADD CONSTRAINT "TrainingAssignGrant_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAssignGrant" ADD CONSTRAINT "TrainingAssignGrant_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
