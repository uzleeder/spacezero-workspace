-- AlterTable
ALTER TABLE "EmployeeSetupItem" ADD COLUMN "employeeConfirmedAt" DATETIME;

-- CreateTable
CREATE TABLE "SetupRequirementTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requirementId" TEXT NOT NULL,
    "profileId" TEXT,
    "teamId" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SetupRequirementTarget_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "SetupRequirement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SetupRequirementTarget_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SetupRequirementTarget_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SetupRequirement" (
    "category" TEXT,
    "verification" TEXT NOT NULL DEFAULT 'MANAGEMENT_VERIFICATION',
    "audience" TEXT NOT NULL DEFAULT 'ALL_EMPLOYEES',
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'MANUAL',
    "rolesJson" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "companyControlled" BOOLEAN NOT NULL DEFAULT false,
    "credentialSystem" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SetupRequirement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SetupRequirement" ("archivedAt", "companyControlled", "createdAt", "credentialSystem", "description", "displayOrder", "id", "key", "kind", "label", "organizationId", "required", "rolesJson", "updatedAt") SELECT "archivedAt", "companyControlled", "createdAt", "credentialSystem", "description", "displayOrder", "id", "key", "kind", "label", "organizationId", "required", "rolesJson", "updatedAt" FROM "SetupRequirement";
DROP TABLE "SetupRequirement";
ALTER TABLE "new_SetupRequirement" RENAME TO "SetupRequirement";
CREATE INDEX "SetupRequirement_organizationId_idx" ON "SetupRequirement"("organizationId");
CREATE UNIQUE INDEX "SetupRequirement_organizationId_key_key" ON "SetupRequirement"("organizationId", "key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "SetupRequirementTarget_profileId_idx" ON "SetupRequirementTarget"("profileId");

-- CreateIndex
CREATE INDEX "SetupRequirementTarget_teamId_idx" ON "SetupRequirementTarget"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "SetupRequirementTarget_requirementId_profileId_key" ON "SetupRequirementTarget"("requirementId", "profileId");

-- CreateIndex
CREATE UNIQUE INDEX "SetupRequirementTarget_requirementId_teamId_key" ON "SetupRequirementTarget"("requirementId", "teamId");

-- Existing role-limited requirements keep their audience.
UPDATE "SetupRequirement" SET "audience" = 'ROLES' WHERE "rolesJson" IS NOT NULL;

