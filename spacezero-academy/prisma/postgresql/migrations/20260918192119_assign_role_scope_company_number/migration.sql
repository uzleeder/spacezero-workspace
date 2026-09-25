-- AlterEnum
ALTER TYPE "AssignmentScope" ADD VALUE 'ROLE';

-- AlterTable
ALTER TABLE "EmployeeSetupItem" ADD COLUMN     "companyNumber" TEXT;

-- AlterTable
ALTER TABLE "TrainingAssignment" ADD COLUMN     "targetRole" "UserRole";
