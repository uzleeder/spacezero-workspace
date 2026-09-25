-- AlterTable
ALTER TABLE "SkillEvidence" ADD COLUMN     "assessmentId" TEXT,
ADD COLUMN     "assessmentType" TEXT,
ADD COLUMN     "attemptNumber" INTEGER,
ADD COLUMN     "difficulty" INTEGER,
ADD COLUMN     "weight" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "TrainingCourse" ADD COLUMN     "audienceJson" TEXT,
ADD COLUMN     "defaultDueDate" TIMESTAMP(3);
