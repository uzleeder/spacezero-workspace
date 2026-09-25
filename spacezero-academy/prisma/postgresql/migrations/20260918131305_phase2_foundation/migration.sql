-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('QUEUED', 'EXTRACTING', 'MAPPING', 'VALIDATING', 'READY_FOR_REVIEW', 'APPROVED', 'FAILED');

-- CreateEnum
CREATE TYPE "AssessmentType" AS ENUM ('QUIZ', 'ROLEPLAY', 'VOICE', 'TECHNICAL', 'PROCESS_SIM', 'PRODUCT_KNOWLEDGE');

-- CreateEnum
CREATE TYPE "AssessmentCreatedVia" AS ENUM ('AI_TRAINING_ANALYSIS', 'AI_CALL_ANALYSIS', 'ADMIN_MANUAL');

-- CreateEnum
CREATE TYPE "AssessmentStatus" AS ENUM ('DRAFT', 'AI_GENERATED', 'APPROVED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('MCQ', 'MULTI_SELECT', 'ORDERING', 'MATCHING', 'SCENARIO', 'SHORT_ANSWER', 'TRUE_FALSE');

-- CreateEnum
CREATE TYPE "CallBatchMode" AS ENUM ('INDIVIDUAL_AGENT', 'BEST_PRACTICE');

-- CreateEnum
CREATE TYPE "CallBatchStatus" AS ENUM ('UPLOADED', 'TRANSCRIBING', 'ANALYZING', 'AGGREGATING', 'GENERATING_PRACTICE', 'READY_FOR_REVIEW', 'APPROVED', 'FAILED');

-- CreateEnum
CREATE TYPE "CallRecordingStatus" AS ENUM ('UPLOADED', 'TRANSCRIBING', 'TRANSCRIBED', 'FAILED');

-- AlterEnum
ALTER TYPE "ModuleContentType" ADD VALUE 'AUDIO';

-- AlterTable
ALTER TABLE "TrainingAttempt" ADD COLUMN     "aiModelVersion" TEXT,
ADD COLUMN     "answersJson" TEXT,
ADD COLUMN     "assessmentId" TEXT,
ADD COLUMN     "level" INTEGER,
ADD COLUMN     "skillBreakdownJson" TEXT,
ADD COLUMN     "transcriptJson" TEXT;

-- AlterTable
ALTER TABLE "TrainingModule" ADD COLUMN     "required" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sourceRefJson" TEXT;

-- CreateTable
CREATE TABLE "TrainingAnalysis" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'QUEUED',
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
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assessment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "courseId" TEXT,
    "createdVia" "AssessmentCreatedVia" NOT NULL,
    "type" "AssessmentType" NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT,
    "level" INTEGER NOT NULL DEFAULT 3,
    "passingScore" INTEGER NOT NULL DEFAULT 70,
    "configJson" TEXT,
    "status" "AssessmentStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "modelVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Assessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "type" "QuestionType" NOT NULL,
    "prompt" TEXT NOT NULL,
    "optionsJson" TEXT,
    "correctAnswerJson" TEXT NOT NULL,
    "explanation" TEXT,
    "skillIdsJson" TEXT,
    "sourceRefJson" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "mode" "CallBatchMode" NOT NULL,
    "targetAgentId" TEXT,
    "status" "CallBatchStatus" NOT NULL DEFAULT 'UPLOADED',
    "aggregatedAnalysisJson" TEXT,
    "generatedCourseId" TEXT,
    "generatedPracticePlanJson" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallRecording" (
    "id" TEXT NOT NULL,
    "callBatchId" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "durationSeconds" INTEGER,
    "originalFilename" TEXT,
    "status" "CallRecordingStatus" NOT NULL DEFAULT 'UPLOADED',
    "transcriptText" TEXT,
    "transcriptTimestampsJson" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallRecording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaProgress" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "trainingModuleId" TEXT NOT NULL,
    "durationSeconds" INTEGER,
    "playbackSpeed" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "watchedRangesJson" TEXT NOT NULL DEFAULT '[]',
    "percentComplete" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastPositionSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MediaProgress_pkey" PRIMARY KEY ("id")
);

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

-- CreateIndex
CREATE INDEX "TrainingAttempt_assessmentId_idx" ON "TrainingAttempt"("assessmentId");

-- AddForeignKey
ALTER TABLE "TrainingAttempt" ADD CONSTRAINT "TrainingAttempt_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAnalysis" ADD CONSTRAINT "TrainingAnalysis_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAnalysis" ADD CONSTRAINT "TrainingAnalysis_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assessment" ADD CONSTRAINT "Assessment_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallBatch" ADD CONSTRAINT "CallBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallBatch" ADD CONSTRAINT "CallBatch_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "Profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallBatch" ADD CONSTRAINT "CallBatch_targetAgentId_fkey" FOREIGN KEY ("targetAgentId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallBatch" ADD CONSTRAINT "CallBatch_generatedCourseId_fkey" FOREIGN KEY ("generatedCourseId") REFERENCES "TrainingCourse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallBatch" ADD CONSTRAINT "CallBatch_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallRecording" ADD CONSTRAINT "CallRecording_callBatchId_fkey" FOREIGN KEY ("callBatchId") REFERENCES "CallBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaProgress" ADD CONSTRAINT "MediaProgress_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaProgress" ADD CONSTRAINT "MediaProgress_trainingModuleId_fkey" FOREIGN KEY ("trainingModuleId") REFERENCES "TrainingModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
