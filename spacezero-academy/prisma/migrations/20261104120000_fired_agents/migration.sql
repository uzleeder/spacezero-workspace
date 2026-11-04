-- Fired agents (lib/firedAgents.js): a company account (its email and saved system logins) outlives the people who use
-- it. Adds empty (NULL) columns and one index only; existing profiles are unchanged.
-- AlterTable
ALTER TABLE "Profile" ADD COLUMN "accountKey" TEXT;
ALTER TABLE "Profile" ADD COLUMN "firedAt" DATETIME;
ALTER TABLE "Profile" ADD COLUMN "firedReason" TEXT;
ALTER TABLE "Profile" ADD COLUMN "firedById" TEXT;

-- CreateIndex
CREATE INDEX "Profile_accountKey_idx" ON "Profile"("accountKey");
