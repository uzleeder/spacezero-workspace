-- CreateTable
CREATE TABLE "Certificate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "courseId" TEXT,
    "issuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Certificate_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CallReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "supervisorId" TEXT NOT NULL,
    "storagePath" TEXT,
    "mimeType" TEXT,
    "feedback" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CallReview_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CallReview_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SkillEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeSkillId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "scoreImpact" REAL,
    "notes" TEXT,
    "recordedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SkillEvidence_employeeSkillId_fkey" FOREIGN KEY ("employeeSkillId") REFERENCES "EmployeeSkill" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SkillEvidence_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "Profile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SkillEvidence" ("createdAt", "employeeSkillId", "id", "notes", "recordedById", "scoreImpact", "sourceId", "sourceType") SELECT "createdAt", "employeeSkillId", "id", "notes", "recordedById", "scoreImpact", "sourceId", "sourceType" FROM "SkillEvidence";
DROP TABLE "SkillEvidence";
ALTER TABLE "new_SkillEvidence" RENAME TO "SkillEvidence";
CREATE INDEX "SkillEvidence_employeeSkillId_idx" ON "SkillEvidence"("employeeSkillId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Certificate_profileId_idx" ON "Certificate"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_profileId_courseId_key" ON "Certificate"("profileId", "courseId");

-- CreateIndex
CREATE INDEX "CallReview_organizationId_idx" ON "CallReview"("organizationId");

-- CreateIndex
CREATE INDEX "CallReview_agentId_idx" ON "CallReview"("agentId");

-- CreateIndex
CREATE INDEX "CallReview_supervisorId_idx" ON "CallReview"("supervisorId");
