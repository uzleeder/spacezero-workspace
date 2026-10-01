-- AlterTable
ALTER TABLE "EmployeeSetupItem" ADD COLUMN "accountType" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SetupRequirement" (
    "ownerRole" TEXT,
    "dueDays" INTEGER,
    "dueDate" DATETIME,
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
    "allowPersonalAccount" BOOLEAN NOT NULL DEFAULT false,
    "credentialSystem" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SetupRequirement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SetupRequirement" ("archivedAt", "audience", "category", "companyControlled", "createdAt", "credentialSystem", "description", "displayOrder", "dueDate", "dueDays", "id", "key", "kind", "label", "organizationId", "ownerRole", "required", "rolesJson", "updatedAt", "verification") SELECT "archivedAt", "audience", "category", "companyControlled", "createdAt", "credentialSystem", "description", "displayOrder", "dueDate", "dueDays", "id", "key", "kind", "label", "organizationId", "ownerRole", "required", "rolesJson", "updatedAt", "verification" FROM "SetupRequirement";
DROP TABLE "SetupRequirement";
ALTER TABLE "new_SetupRequirement" RENAME TO "SetupRequirement";
CREATE INDEX "SetupRequirement_organizationId_idx" ON "SetupRequirement"("organizationId");
CREATE UNIQUE INDEX "SetupRequirement_organizationId_key_key" ON "SetupRequirement"("organizationId", "key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
