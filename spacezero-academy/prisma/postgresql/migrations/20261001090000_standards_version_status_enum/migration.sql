-- StandardsVersion.status was originally created as TEXT, while the Prisma
-- schema now uses the shared TrainingStatus enum.
ALTER TABLE "StandardsVersion"
ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "StandardsVersion"
ALTER COLUMN "status" TYPE "TrainingStatus"
USING "status"::"TrainingStatus";

ALTER TABLE "StandardsVersion"
ALTER COLUMN "status" SET DEFAULT 'DRAFT'::"TrainingStatus";
