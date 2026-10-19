-- AlterTable
ALTER TABLE "SkillEvidence" ADD COLUMN "assessmentId" TEXT;
ALTER TABLE "SkillEvidence" ADD COLUMN "assessmentType" TEXT;
ALTER TABLE "SkillEvidence" ADD COLUMN "attemptNumber" INTEGER;
ALTER TABLE "SkillEvidence" ADD COLUMN "difficulty" INTEGER;
ALTER TABLE "SkillEvidence" ADD COLUMN "weight" REAL;

-- AlterTable
ALTER TABLE "TrainingCourse" ADD COLUMN "audienceJson" TEXT;
ALTER TABLE "TrainingCourse" ADD COLUMN "defaultDueDate" DATETIME;
