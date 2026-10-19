-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;

-- AlterTable
ALTER TABLE "SkillScoreHistory" ADD COLUMN "confidenceLevel" TEXT;
ALTER TABLE "SkillScoreHistory" ADD COLUMN "engineVersion" INTEGER;
ALTER TABLE "SkillScoreHistory" ADD COLUMN "evidenceCount" INTEGER;

-- CreateTable
CREATE TABLE "CoachingNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "skillId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CoachingNote_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CoachingNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DevelopmentRecommendation" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "resolvedById" TEXT,
    CONSTRAINT "DevelopmentRecommendation_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DevelopmentPath" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roleKey" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DevelopmentPathStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pathId" TEXT NOT NULL,
    "dayOffset" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "courseId" TEXT,
    "assessmentId" TEXT,
    "autoAssign" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "DevelopmentPathStep_pathId_fkey" FOREIGN KEY ("pathId") REFERENCES "DevelopmentPath" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AssignmentRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "roleKey" TEXT,
    "conditionJson" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'RECOMMEND',
    "courseId" TEXT,
    "assessmentId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CertificationDefinition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'CERTIFICATION',
    "roleKey" TEXT,
    "requirementsJson" TEXT NOT NULL,
    "validityDays" INTEGER,
    "renewalNote" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EarnedCertification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "definitionId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "issuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "snapshotJson" TEXT NOT NULL,
    "issuedById" TEXT,
    CONSTRAINT "EarnedCertification_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "CertificationDefinition" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EarnedCertification_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RetentionCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "offsetDays" INTEGER NOT NULL,
    "dueAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "outcome" TEXT,
    "detailJson" TEXT,
    "checkedAt" DATETIME
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EmployeeSkill" (
    "confidenceLevel" TEXT NOT NULL DEFAULT 'NONE',
    "engineVersion" INTEGER,
    "lastEvidenceAt" DATETIME,
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "currentScore" REAL NOT NULL DEFAULT 0,
    "confidence" REAL NOT NULL DEFAULT 0,
    "evidenceCount" INTEGER NOT NULL DEFAULT 0,
    "lastAssessedAt" DATETIME,
    "recommendedPractice" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmployeeSkill_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EmployeeSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_EmployeeSkill" ("confidence", "createdAt", "currentScore", "evidenceCount", "id", "lastAssessedAt", "profileId", "recommendedPractice", "skillId", "updatedAt") SELECT "confidence", "createdAt", "currentScore", "evidenceCount", "id", "lastAssessedAt", "profileId", "recommendedPractice", "skillId", "updatedAt" FROM "EmployeeSkill";
DROP TABLE "EmployeeSkill";
ALTER TABLE "new_EmployeeSkill" RENAME TO "EmployeeSkill";
CREATE INDEX "EmployeeSkill_profileId_idx" ON "EmployeeSkill"("profileId");
CREATE INDEX "EmployeeSkill_skillId_currentScore_idx" ON "EmployeeSkill"("skillId", "currentScore");
CREATE UNIQUE INDEX "EmployeeSkill_profileId_skillId_key" ON "EmployeeSkill"("profileId", "skillId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

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

-- CreateIndex
CREATE INDEX "Notification_profileId_readAt_idx" ON "Notification"("profileId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_profileId_dedupeKey_key" ON "Notification"("profileId", "dedupeKey");

-- CreateIndex
CREATE INDEX "SkillEvidence_employeeSkillId_createdAt_idx" ON "SkillEvidence"("employeeSkillId", "createdAt");

-- CreateIndex
CREATE INDEX "SkillScoreHistory_employeeSkillId_recordedAt_idx" ON "SkillScoreHistory"("employeeSkillId", "recordedAt");

