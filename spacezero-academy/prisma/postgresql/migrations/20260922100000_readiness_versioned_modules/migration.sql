-- AlterTable
ALTER TABLE "SetupRequirement" ADD COLUMN     "ownerRole" TEXT,
ADD COLUMN     "dueDays" INTEGER,
ADD COLUMN     "dueDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TrainingCourse" ADD COLUMN     "onboardingForNewHires" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TrainingModule" ADD COLUMN     "addedInVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "removedInVersion" INTEGER;
