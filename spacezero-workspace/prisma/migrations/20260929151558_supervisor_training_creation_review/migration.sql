-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TrainingCourse" (
    "audienceJson" TEXT,
    "defaultDueDate" DATETIME,
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
    "assignPolicy" TEXT NOT NULL DEFAULT 'ADMIN_ONLY',
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    "reviewStatus" TEXT NOT NULL DEFAULT 'NONE',
    "reviewNote" TEXT,
    "submittedAt" DATETIME,
    "submittedById" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'MANUAL',
    "purpose" TEXT,
    "workspaceArchivedAt" DATETIME,
    "draftVersion" INTEGER NOT NULL DEFAULT 1,
    "publishedVersion" INTEGER NOT NULL DEFAULT 0,
    "sentAt" DATETIME,
    "sentById" TEXT,
    "onboardingForNewHires" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "TrainingCourse_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TrainingCourse_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingCourse_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "Profile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_TrainingCourse" ("archivedAt", "assignPolicy", "audienceJson", "createdAt", "createdById", "defaultDueDate", "description", "draftVersion", "durationMinutes", "id", "mandatory", "onboardingForNewHires", "organizationId", "origin", "passingScore", "publishedVersion", "purpose", "roleKey", "sentAt", "sentById", "status", "thumbnailUrl", "title", "updatedAt", "workspaceArchivedAt") SELECT "archivedAt", "assignPolicy", "audienceJson", "createdAt", "createdById", "defaultDueDate", "description", "draftVersion", "durationMinutes", "id", "mandatory", "onboardingForNewHires", "organizationId", "origin", "passingScore", "publishedVersion", "purpose", "roleKey", "sentAt", "sentById", "status", "thumbnailUrl", "title", "updatedAt", "workspaceArchivedAt" FROM "TrainingCourse";
DROP TABLE "TrainingCourse";
ALTER TABLE "new_TrainingCourse" RENAME TO "TrainingCourse";
CREATE INDEX "TrainingCourse_organizationId_idx" ON "TrainingCourse"("organizationId");
CREATE INDEX "TrainingCourse_status_idx" ON "TrainingCourse"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
