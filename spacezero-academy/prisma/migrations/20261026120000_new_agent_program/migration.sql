-- New Agent Program (lib/newAgentProgram.js): the plan extends DevelopmentPath / DevelopmentPathStep; each new agent's run is an AgentProgram with its AgentProgramTask rows.
-- CreateTable
CREATE TABLE "AgentProgram" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "pathId" TEXT,
    "startDate" TEXT NOT NULL,
    "startDay" INTEGER NOT NULL DEFAULT 1,
    "workDaysJson" TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
    "workDaysConfirmedAt" DATETIME,
    "daysOffJson" TEXT NOT NULL DEFAULT '[]',
    "extraDays" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startedById" TEXT,
    "stoppedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentProgram_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentProgram_pathId_fkey" FOREIGN KEY ("pathId") REFERENCES "DevelopmentPath" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentProgramTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "programId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "stepId" TEXT,
    "day" INTEGER NOT NULL,
    "owner" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "howTo" TEXT,
    "minutes" INTEGER,
    "courseId" TEXT,
    "standardId" TEXT,
    "system" TEXT,
    "target" INTEGER,
    "doneAt" DATETIME,
    "doneById" TEXT,
    "note" TEXT,
    "resultJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentProgramTask_programId_fkey" FOREIGN KEY ("programId") REFERENCES "AgentProgram" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DevelopmentPath" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roleKey" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "program" BOOLEAN NOT NULL DEFAULT false,
    "lengthDays" INTEGER NOT NULL DEFAULT 20,
    "callsPerWeekJson" TEXT,
    "weekTitlesJson" TEXT,
    "dailyCheckIn" BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO "new_DevelopmentPath" ("createdAt", "createdById", "description", "id", "isActive", "name", "organizationId", "roleKey") SELECT "createdAt", "createdById", "description", "id", "isActive", "name", "organizationId", "roleKey" FROM "DevelopmentPath";
DROP TABLE "DevelopmentPath";
ALTER TABLE "new_DevelopmentPath" RENAME TO "DevelopmentPath";
CREATE INDEX "DevelopmentPath_organizationId_idx" ON "DevelopmentPath"("organizationId");
CREATE TABLE "new_DevelopmentPathStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pathId" TEXT NOT NULL,
    "dayOffset" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "courseId" TEXT,
    "assessmentId" TEXT,
    "autoAssign" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "owner" TEXT NOT NULL DEFAULT 'AGENT',
    "kind" TEXT NOT NULL DEFAULT 'TRAINING',
    "howTo" TEXT,
    "minutes" INTEGER,
    "standardId" TEXT,
    "system" TEXT,
    CONSTRAINT "DevelopmentPathStep_pathId_fkey" FOREIGN KEY ("pathId") REFERENCES "DevelopmentPath" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DevelopmentPathStep" ("assessmentId", "autoAssign", "courseId", "dayOffset", "displayOrder", "id", "pathId", "title") SELECT "assessmentId", "autoAssign", "courseId", "dayOffset", "displayOrder", "id", "pathId", "title" FROM "DevelopmentPathStep";
DROP TABLE "DevelopmentPathStep";
ALTER TABLE "new_DevelopmentPathStep" RENAME TO "DevelopmentPathStep";
CREATE INDEX "DevelopmentPathStep_pathId_idx" ON "DevelopmentPathStep"("pathId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "AgentProgram_profileId_key" ON "AgentProgram"("profileId");

-- CreateIndex
CREATE INDEX "AgentProgram_organizationId_status_idx" ON "AgentProgram"("organizationId", "status");

-- CreateIndex
CREATE INDEX "AgentProgramTask_programId_day_idx" ON "AgentProgramTask"("programId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProgramTask_programId_key_key" ON "AgentProgramTask"("programId", "key");

