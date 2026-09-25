-- AlterTable
ALTER TABLE "TrainingCourse" ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "purpose" TEXT,
ADD COLUMN     "workspaceArchivedAt" TIMESTAMP(3),
ADD COLUMN     "draftVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "publishedVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "sentById" TEXT;

-- AlterTable
ALTER TABLE "TrainingAnalysis" ADD COLUMN     "purpose" TEXT,
ADD COLUMN     "promptVersion" TEXT,
ADD COLUMN     "sourceHash" TEXT,
ADD COLUMN     "completedStep" TEXT,
ADD COLUMN     "insightsJson" TEXT,
ADD COLUMN     "startedById" TEXT;

-- AlterTable
ALTER TABLE "Assessment" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "promptVersion" TEXT,
ADD COLUMN     "sourceAssessmentId" TEXT;

-- AlterTable
ALTER TABLE "TrainingAssignment" ADD COLUMN     "courseVersion" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "PracticeMaterial" ADD COLUMN     "migratedCourseId" TEXT,
ADD COLUMN     "migratedBatchId" TEXT;

-- AlterTable
ALTER TABLE "CallBatch" ADD COLUMN     "title" TEXT,
ADD COLUMN     "purpose" TEXT,
ADD COLUMN     "analysisRequestedAt" TIMESTAMP(3),
ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TrainingVersion" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "snapshotJson" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "TrainingVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiTask" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrainingVersion_courseId_version_key" ON "TrainingVersion"("courseId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AiTask_activeKey_key" ON "AiTask"("activeKey");

-- CreateIndex
CREATE INDEX "AiTask_courseId_taskType_idx" ON "AiTask"("courseId", "taskType");

-- CreateIndex
CREATE INDEX "AiTask_status_idx" ON "AiTask"("status");

-- AddForeignKey
ALTER TABLE "TrainingVersion" ADD CONSTRAINT "TrainingVersion_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill (facts only): courses that already went through the AI pipeline are AI Practice work; anything that was
-- sent to Training or assigned is published version 1.
UPDATE "TrainingCourse" SET "origin" = 'AI_PRACTICE' WHERE "id" IN (SELECT "courseId" FROM "TrainingAnalysis") OR "id" IN (SELECT "generatedCourseId" FROM "CallBatch" WHERE "generatedCourseId" IS NOT NULL);
UPDATE "TrainingCourse" SET "publishedVersion" = 1 WHERE "status" = 'PUBLISHED' OR "id" IN (SELECT "courseId" FROM "TrainingAssignment");
-- Batches that were already processed (or are being processed) were started by someone; only never-processed uploads stay "saved".
UPDATE "CallBatch" SET "analysisRequestedAt" = "createdAt" WHERE "status" <> 'UPLOADED';
