-- AlterTable
ALTER TABLE "TrainingCourse" ADD COLUMN     "mandatory" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "passingScore" INTEGER NOT NULL DEFAULT 70;
