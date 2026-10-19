-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Profile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "photoUrl" TEXT,
    "phonePrimary" TEXT,
    "phoneSecondary" TEXT,
    "whatsappNumber" TEXT,
    "telegramContact" TEXT,
    "phoneUzbekistan" TEXT,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INVITED',
    "employmentStartDate" DATETIME NOT NULL,
    "lastActivityAt" DATETIME,
    "createdById" TEXT,
    "testOwnerAdminId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    CONSTRAINT "Profile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Profile_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Profile" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Profile_testOwnerAdminId_fkey" FOREIGN KEY ("testOwnerAdminId") REFERENCES "Profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Profile" ("archivedAt", "createdAt", "createdById", "email", "employmentStartDate", "fullName", "id", "lastActivityAt", "organizationId", "passwordHash", "phonePrimary", "phoneSecondary", "phoneUzbekistan", "photoUrl", "role", "status", "telegramContact", "updatedAt", "username", "whatsappNumber") SELECT "archivedAt", "createdAt", "createdById", "email", "employmentStartDate", "fullName", "id", "lastActivityAt", "organizationId", "passwordHash", "phonePrimary", "phoneSecondary", "phoneUzbekistan", "photoUrl", "role", "status", "telegramContact", "updatedAt", "username", "whatsappNumber" FROM "Profile";
DROP TABLE "Profile";
ALTER TABLE "new_Profile" RENAME TO "Profile";
CREATE UNIQUE INDEX "Profile_username_key" ON "Profile"("username");
CREATE UNIQUE INDEX "Profile_email_key" ON "Profile"("email");
CREATE INDEX "Profile_organizationId_idx" ON "Profile"("organizationId");
CREATE INDEX "Profile_role_idx" ON "Profile"("role");
CREATE INDEX "Profile_testOwnerAdminId_idx" ON "Profile"("testOwnerAdminId");
CREATE INDEX "Profile_status_idx" ON "Profile"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
