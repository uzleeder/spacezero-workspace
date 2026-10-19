-- AlterEnum
ALTER TYPE "SetupRequirementKind" ADD VALUE 'PASSPORT';

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "passportExpiresAt" TIMESTAMP(3),
ADD COLUMN     "passportNumberEnc" TEXT;
