ALTER TABLE "TrainingAssignment" ADD COLUMN "assessmentId" TEXT;
ALTER TABLE "TrainingAssignment" ADD COLUMN "requiredAttempts" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "TrainingAssignment" ADD COLUMN "minimumScore" INTEGER NOT NULL DEFAULT 70;
CREATE TABLE "PracticeSession" ("id" TEXT NOT NULL PRIMARY KEY,"profileId" TEXT NOT NULL,"assessmentId" TEXT NOT NULL,"dataJson" TEXT NOT NULL DEFAULT '{}',"completedAttemptId" TEXT,"busy" BOOLEAN NOT NULL DEFAULT false,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL);
CREATE INDEX "PracticeSession_profileId_assessmentId_idx" ON "PracticeSession"("profileId","assessmentId");
