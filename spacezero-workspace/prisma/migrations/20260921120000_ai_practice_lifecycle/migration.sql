-- AlterTable
ALTER TABLE "CallBatch" ADD COLUMN "analysisRequestedAt" DATETIME;
ALTER TABLE "CallBatch" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "CallBatch" ADD COLUMN "purpose" TEXT;
ALTER TABLE "CallBatch" ADD COLUMN "title" TEXT;

-- AlterTable
ALTER TABLE "PracticeMaterial" ADD COLUMN "migratedBatchId" TEXT;
ALTER TABLE "PracticeMaterial" ADD COLUMN "migratedCourseId" TEXT;

-- AlterTable
ALTER TABLE "TrainingAnalysis" ADD COLUMN "completedStep" TEXT;
ALTER TABLE "TrainingAnalysis" ADD COLUMN "insightsJson" TEXT;
ALTER TABLE "TrainingAnalysis" ADD COLUMN "promptVersion" TEXT;
ALTER TABLE "TrainingAnalysis" ADD COLUMN "purpose" TEXT;
ALTER TABLE "TrainingAnalysis" ADD COLUMN "sourceHash" TEXT;
ALTER TABLE "TrainingAnalysis" ADD COLUMN "startedById" TEXT;

-- CreateTable
CREATE TABLE "TrainingVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "snapshotJson" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedAt" DATETIME,
    "publishedById" TEXT,
    "publishedAt" DATETIME,
    CONSTRAINT "TrainingVersion_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "TrainingCourse" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "courseId" TEXT,
    "batchId" TEXT,
    "taskType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "activeKey" TEXT,
    "payloadJson" TEXT,
    "resultJson" TEXT,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "promptVersion" TEXT,
    "sourceHash" TEXT,
    "requestedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Assessment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "courseId" TEXT,
    "createdVia" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT,
    "level" INTEGER NOT NULL DEFAULT 3,
    "passingScore" INTEGER NOT NULL DEFAULT 70,
    "configJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "promptVersion" TEXT,
    "sourceAssessmentId" TEXT,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" DATETIME,
    "modelVersion" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    CONSTRAINT "Assessment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Assessment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "TrainingCourse" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Assessment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Assessment_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Profile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Assessment" ("approvedAt", "approvedById", "archivedAt", "configJson", "courseId", "createdAt", "createdById", "createdVia", "id", "instructions", "level", "modelVersion", "organizationId", "passingScore", "status", "title", "type", "updatedAt") SELECT "approvedAt", "approvedById", "archivedAt", "configJson", "courseId", "createdAt", "createdById", "createdVia", "id", "instructions", "level", "modelVersion", "organizationId", "passingScore", "status", "title", "type", "updatedAt" FROM "Assessment";
DROP TABLE "Assessment";
ALTER TABLE "new_Assessment" RENAME TO "Assessment";
CREATE INDEX "Assessment_organizationId_idx" ON "Assessment"("organizationId");
CREATE INDEX "Assessment_courseId_idx" ON "Assessment"("courseId");
CREATE INDEX "Assessment_status_idx" ON "Assessment"("status");
CREATE TABLE "new_TrainingAssignment" (
    "courseVersion" INTEGER NOT NULL DEFAULT 1,
    "targetRole" TEXT,
    "assessmentId" TEXT,
    "requiredAttempts" INTEGER NOT NULL DEFAULT 1,
    "minimumScore" INTEGER NOT NULL DEFAULT 70,
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "targetTeamId" TEXT,
    "dueDate" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrainingAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrainingAssignment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "TrainingCourse" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrainingAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "Profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingAssignment_targetTeamId_fkey" FOREIGN KEY ("targetTeamId") REFERENCES "Team" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_TrainingAssignment" ("assessmentId", "assignedById", "courseId", "createdAt", "dueDate", "id", "minimumScore", "notes", "organizationId", "requiredAttempts", "scope", "targetRole", "targetTeamId") SELECT "assessmentId", "assignedById", "courseId", "createdAt", "dueDate", "id", "minimumScore", "notes", "organizationId", "requiredAttempts", "scope", "targetRole", "targetTeamId" FROM "TrainingAssignment";
DROP TABLE "TrainingAssignment";
ALTER TABLE "new_TrainingAssignment" RENAME TO "TrainingAssignment";
CREATE INDEX "TrainingAssignment_organizationId_idx" ON "TrainingAssignment"("organizationId");
CREATE INDEX "TrainingAssignment_courseId_idx" ON "TrainingAssignment"("courseId");
CREATE TABLE "new_TrainingCourse" (
    "audienceJson" TEXT,
    "defaultDueDate" DATETIME,
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "roleKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "thumbnailUrl" TEXT,
    "durationMinutes" INTEGER,
    "mandatory" BOOLEAN NOT NULL DEFAULT true,
    "passingScore" INTEGER NOT NULL DEFAULT 70,
    "assignPolicy" TEXT NOT NULL DEFAULT 'ADMIN_ONLY',
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    "origin" TEXT NOT NULL DEFAULT 'MANUAL',
    "purpose" TEXT,
    "workspaceArchivedAt" DATETIME,
    "draftVersion" INTEGER NOT NULL DEFAULT 1,
    "publishedVersion" INTEGER NOT NULL DEFAULT 0,
    "sentAt" DATETIME,
    "sentById" TEXT,
    CONSTRAINT "TrainingCourse_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrainingCourse_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_TrainingCourse" ("archivedAt", "assignPolicy", "audienceJson", "createdAt", "createdById", "defaultDueDate", "description", "durationMinutes", "id", "mandatory", "organizationId", "passingScore", "roleKey", "status", "thumbnailUrl", "title", "updatedAt") SELECT "archivedAt", "assignPolicy", "audienceJson", "createdAt", "createdById", "defaultDueDate", "description", "durationMinutes", "id", "mandatory", "organizationId", "passingScore", "roleKey", "status", "thumbnailUrl", "title", "updatedAt" FROM "TrainingCourse";
DROP TABLE "TrainingCourse";
ALTER TABLE "new_TrainingCourse" RENAME TO "TrainingCourse";
CREATE INDEX "TrainingCourse_organizationId_idx" ON "TrainingCourse"("organizationId");
CREATE INDEX "TrainingCourse_status_idx" ON "TrainingCourse"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "TrainingVersion_courseId_version_key" ON "TrainingVersion"("courseId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AiTask_activeKey_key" ON "AiTask"("activeKey");

-- CreateIndex
CREATE INDEX "AiTask_courseId_taskType_idx" ON "AiTask"("courseId", "taskType");

-- CreateIndex
CREATE INDEX "AiTask_status_idx" ON "AiTask"("status");

-- Backfill (facts only): courses that already went through the AI pipeline are AI Practice work; anything that was
-- sent to Training or assigned is published version 1.
UPDATE "TrainingCourse" SET "origin" = 'AI_PRACTICE' WHERE "id" IN (SELECT "courseId" FROM "TrainingAnalysis") OR "id" IN (SELECT "generatedCourseId" FROM "CallBatch" WHERE "generatedCourseId" IS NOT NULL);
UPDATE "TrainingCourse" SET "publishedVersion" = 1 WHERE "status" = 'PUBLISHED' OR "id" IN (SELECT "courseId" FROM "TrainingAssignment");
-- Batches that were already processed (or are being processed) were started by someone; only never-processed uploads stay "saved".
UPDATE "CallBatch" SET "analysisRequestedAt" = "createdAt" WHERE "status" <> 'UPLOADED';
