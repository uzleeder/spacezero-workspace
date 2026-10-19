-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "dedupeKey" TEXT;

-- AlterTable
ALTER TABLE "SkillScoreHistory" ADD COLUMN     "confidenceLevel" TEXT,
ADD COLUMN     "engineVersion" INTEGER,
ADD COLUMN     "evidenceCount" INTEGER;

-- AlterTable
ALTER TABLE "EmployeeSkill" ADD COLUMN     "confidenceLevel" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "engineVersion" INTEGER,
ADD COLUMN     "lastEvidenceAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CoachingNote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "skillId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoachingNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevelopmentRecommendation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "skillId" TEXT,
    "courseId" TEXT,
    "assessmentId" TEXT,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 50,
    "estimatedMinutes" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "DevelopmentRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevelopmentPath" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roleKey" "UserRole",
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DevelopmentPath_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevelopmentPathStep" (
    "id" TEXT NOT NULL,
    "pathId" TEXT NOT NULL,
    "dayOffset" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "courseId" TEXT,
    "assessmentId" TEXT,
    "autoAssign" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DevelopmentPathStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentRule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "roleKey" "UserRole",
    "conditionJson" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'RECOMMEND',
    "courseId" TEXT,
    "assessmentId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssignmentRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CertificationDefinition" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'CERTIFICATION',
    "roleKey" "UserRole",
    "requirementsJson" TEXT NOT NULL,
    "validityDays" INTEGER,
    "renewalNote" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CertificationDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EarnedCertification" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "snapshotJson" TEXT NOT NULL,
    "issuedById" TEXT,

    CONSTRAINT "EarnedCertification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetentionCheck" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "offsetDays" INTEGER NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "outcome" TEXT,
    "detailJson" TEXT,
    "checkedAt" TIMESTAMP(3),

    CONSTRAINT "RetentionCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeSkill_skillId_currentScore_idx" ON "EmployeeSkill"("skillId", "currentScore");

-- CreateIndex
CREATE INDEX "SkillScoreHistory_employeeSkillId_recordedAt_idx" ON "SkillScoreHistory"("employeeSkillId", "recordedAt");

-- CreateIndex
CREATE INDEX "SkillEvidence_employeeSkillId_createdAt_idx" ON "SkillEvidence"("employeeSkillId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_profileId_readAt_idx" ON "Notification"("profileId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_profileId_dedupeKey_key" ON "Notification"("profileId", "dedupeKey");

-- CreateIndex
CREATE INDEX "CoachingNote_profileId_createdAt_idx" ON "CoachingNote"("profileId", "createdAt");

-- CreateIndex
CREATE INDEX "DevelopmentRecommendation_organizationId_status_idx" ON "DevelopmentRecommendation"("organizationId", "status");

-- CreateIndex
CREATE INDEX "DevelopmentRecommendation_profileId_status_idx" ON "DevelopmentRecommendation"("profileId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DevelopmentRecommendation_profileId_sourceKey_key" ON "DevelopmentRecommendation"("profileId", "sourceKey");

-- CreateIndex
CREATE INDEX "DevelopmentPath_organizationId_idx" ON "DevelopmentPath"("organizationId");

-- CreateIndex
CREATE INDEX "DevelopmentPathStep_pathId_idx" ON "DevelopmentPathStep"("pathId");

-- CreateIndex
CREATE INDEX "AssignmentRule_organizationId_isActive_idx" ON "AssignmentRule"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "CertificationDefinition_organizationId_isActive_idx" ON "CertificationDefinition"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "EarnedCertification_profileId_status_idx" ON "EarnedCertification"("profileId", "status");

-- CreateIndex
CREATE INDEX "EarnedCertification_definitionId_idx" ON "EarnedCertification"("definitionId");

-- CreateIndex
CREATE INDEX "RetentionCheck_status_dueAt_idx" ON "RetentionCheck"("status", "dueAt");

-- CreateIndex
CREATE INDEX "RetentionCheck_organizationId_profileId_idx" ON "RetentionCheck"("organizationId", "profileId");

-- CreateIndex
CREATE UNIQUE INDEX "RetentionCheck_recipientId_offsetDays_key" ON "RetentionCheck"("recipientId", "offsetDays");

-- AddForeignKey
ALTER TABLE "CoachingNote" ADD CONSTRAINT "CoachingNote_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachingNote" ADD CONSTRAINT "CoachingNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevelopmentRecommendation" ADD CONSTRAINT "DevelopmentRecommendation_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevelopmentPathStep" ADD CONSTRAINT "DevelopmentPathStep_pathId_fkey" FOREIGN KEY ("pathId") REFERENCES "DevelopmentPath"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EarnedCertification" ADD CONSTRAINT "EarnedCertification_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "CertificationDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EarnedCertification" ADD CONSTRAINT "EarnedCertification_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
