-- StandardsVersion.status was originally created as TEXT, while the Prisma
-- schema now uses the shared TrainingStatus enum.
ALTER TABLE "StandardsVersion"
ALTER COLUMN "status" TYPE "TrainingStatus"
USING "status"::"TrainingStatus";
