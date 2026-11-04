-- Fired agents (lib/firedAgents.js): a company account (its email and saved system logins) outlives the people who use
-- it. Adds empty (NULL) columns and one index only; existing profiles are unchanged.
-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "accountKey" TEXT,
ADD COLUMN     "firedAt" TIMESTAMP(3),
ADD COLUMN     "firedReason" TEXT,
ADD COLUMN     "firedById" TEXT;

-- CreateIndex
CREATE INDEX "Profile_accountKey_idx" ON "Profile"("accountKey");
