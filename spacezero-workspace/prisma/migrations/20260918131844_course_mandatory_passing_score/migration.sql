-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TrainingCourse" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "roleKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "thumbnailUrl" TEXT,
    "durationMinutes" INTEGER,
    "mandatory" BOOLEAN NOT NULL DEFAULT true,
    "passingScore" INTEGER NOT NULL DEFAULT 70,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    CONSTRAINT "TrainingCourse_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrainingCourse_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_TrainingCourse" ("archivedAt", "createdAt", "createdById", "description", "durationMinutes", "id", "organizationId", "roleKey", "status", "thumbnailUrl", "title", "updatedAt") SELECT "archivedAt", "createdAt", "createdById", "description", "durationMinutes", "id", "organizationId", "roleKey", "status", "thumbnailUrl", "title", "updatedAt" FROM "TrainingCourse";
DROP TABLE "TrainingCourse";
ALTER TABLE "new_TrainingCourse" RENAME TO "TrainingCourse";
CREATE INDEX "TrainingCourse_organizationId_idx" ON "TrainingCourse"("organizationId");
CREATE INDEX "TrainingCourse_status_idx" ON "TrainingCourse"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
