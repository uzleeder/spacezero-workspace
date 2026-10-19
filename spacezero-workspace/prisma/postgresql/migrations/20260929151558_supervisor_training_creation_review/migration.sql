-- CreateEnum
CREATE TYPE "CourseReviewStatus" AS ENUM ('NONE', 'SUBMITTED', 'CHANGES_REQUESTED');

-- AlterTable
ALTER TABLE "TrainingCourse" ADD COLUMN     "reviewStatus" "CourseReviewStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "submittedById" TEXT;

-- AddForeignKey
ALTER TABLE "TrainingCourse" ADD CONSTRAINT "TrainingCourse_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
