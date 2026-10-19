-- CreateTable
CREATE TABLE "TrainingAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "classificationsJson" TEXT,
    "objectivesJson" TEXT,
    "extractedSkillsJson" TEXT,
    "criticalKnowledgeJson" TEXT,
    "practicalBehaviorsJson" TEXT,
    "commonMistakesJson" TEXT,
    "difficulty" TEXT,
    "recommendedMethodsJson" TEXT,
    "recommendedIntensityJson" TEXT,
    "sourceReferencesJson" TEXT,
    "validationNotesJson" TEXT,
    "modelVersion" TEXT,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "approvedById" TEXT,
    "approvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TrainingAnalysis_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "TrainingCourse" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrainingAnalysis_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Profile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Assessment" (
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

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assessmentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "optionsJson" TEXT,
    "correctAnswerJson" TEXT NOT NULL,
    "explanation" TEXT,
    "skillIdsJson" TEXT,
    "sourceRefJson" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Question_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CallBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "targetAgentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "aggregatedAnalysisJson" TEXT,
    "generatedCourseId" TEXT,
    "generatedPracticePlanJson" TEXT,
    "approvedById" TEXT,
    "approvedAt" DATETIME,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CallBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CallBatch_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "Profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CallBatch_targetAgentId_fkey" FOREIGN KEY ("targetAgentId") REFERENCES "Profile" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CallBatch_generatedCourseId_fkey" FOREIGN KEY ("generatedCourseId") REFERENCES "TrainingCourse" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CallBatch_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Profile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CallRecording" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "callBatchId" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "durationSeconds" INTEGER,
    "originalFilename" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "transcriptText" TEXT,
    "transcriptTimestampsJson" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CallRecording_callBatchId_fkey" FOREIGN KEY ("callBatchId") REFERENCES "CallBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MediaProgress" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "trainingModuleId" TEXT NOT NULL,
    "durationSeconds" INTEGER,
    "playbackSpeed" REAL NOT NULL DEFAULT 1,
    "watchedRangesJson" TEXT NOT NULL DEFAULT '[]',
    "percentComplete" REAL NOT NULL DEFAULT 0,
    "lastPositionSeconds" REAL NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "MediaProgress_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MediaProgress_trainingModuleId_fkey" FOREIGN KEY ("trainingModuleId") REFERENCES "TrainingModule" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TrainingAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipientId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "score" REAL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "retakeRequestedById" TEXT,
    "retakeRequestedAt" DATETIME,
    "assessmentId" TEXT,
    "skillBreakdownJson" TEXT,
    "answersJson" TEXT,
    "transcriptJson" TEXT,
    "level" INTEGER,
    "aiModelVersion" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TrainingAttempt_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "TrainingAssignmentRecipient" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrainingAttempt_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrainingAttempt_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_TrainingAttempt" ("attemptNumber", "completedAt", "createdAt", "id", "profileId", "recipientId", "retakeRequestedAt", "retakeRequestedById", "score", "startedAt", "status", "updatedAt") SELECT "attemptNumber", "completedAt", "createdAt", "id", "profileId", "recipientId", "retakeRequestedAt", "retakeRequestedById", "score", "startedAt", "status", "updatedAt" FROM "TrainingAttempt";
DROP TABLE "TrainingAttempt";
ALTER TABLE "new_TrainingAttempt" RENAME TO "TrainingAttempt";
CREATE INDEX "TrainingAttempt_recipientId_idx" ON "TrainingAttempt"("recipientId");
CREATE INDEX "TrainingAttempt_profileId_idx" ON "TrainingAttempt"("profileId");
CREATE INDEX "TrainingAttempt_assessmentId_idx" ON "TrainingAttempt"("assessmentId");
CREATE TABLE "new_TrainingModule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "contentType" TEXT NOT NULL,
    "storagePath" TEXT,
    "externalUrl" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "durationMinutes" INTEGER,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "sourceRefJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TrainingModule_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "TrainingCourse" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TrainingModule" ("contentType", "courseId", "createdAt", "description", "displayOrder", "durationMinutes", "externalUrl", "id", "storagePath", "title", "updatedAt") SELECT "contentType", "courseId", "createdAt", "description", "displayOrder", "durationMinutes", "externalUrl", "id", "storagePath", "title", "updatedAt" FROM "TrainingModule";
DROP TABLE "TrainingModule";
ALTER TABLE "new_TrainingModule" RENAME TO "TrainingModule";
CREATE INDEX "TrainingModule_courseId_idx" ON "TrainingModule"("courseId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAnalysis_courseId_key" ON "TrainingAnalysis"("courseId");

-- CreateIndex
CREATE INDEX "TrainingAnalysis_status_idx" ON "TrainingAnalysis"("status");

-- CreateIndex
CREATE INDEX "Assessment_organizationId_idx" ON "Assessment"("organizationId");

-- CreateIndex
CREATE INDEX "Assessment_courseId_idx" ON "Assessment"("courseId");

-- CreateIndex
CREATE INDEX "Assessment_status_idx" ON "Assessment"("status");

-- CreateIndex
CREATE INDEX "Question_assessmentId_idx" ON "Question"("assessmentId");

-- CreateIndex
CREATE INDEX "CallBatch_organizationId_idx" ON "CallBatch"("organizationId");

-- CreateIndex
CREATE INDEX "CallBatch_status_idx" ON "CallBatch"("status");

-- CreateIndex
CREATE INDEX "CallBatch_targetAgentId_idx" ON "CallBatch"("targetAgentId");

-- CreateIndex
CREATE INDEX "CallRecording_callBatchId_idx" ON "CallRecording"("callBatchId");

-- CreateIndex
CREATE INDEX "MediaProgress_trainingModuleId_idx" ON "MediaProgress"("trainingModuleId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaProgress_profileId_trainingModuleId_key" ON "MediaProgress"("profileId", "trainingModuleId");
