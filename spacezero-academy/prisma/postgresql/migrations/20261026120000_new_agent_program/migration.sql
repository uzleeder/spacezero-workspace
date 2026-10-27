-- New Agent Program (lib/newAgentProgram.js): the plan extends DevelopmentPath / DevelopmentPathStep; each new agent's run is an AgentProgram with its AgentProgramTask rows.
-- AlterTable
ALTER TABLE "DevelopmentPath" ADD COLUMN     "callsPerWeekJson" TEXT,
ADD COLUMN     "dailyCheckIn" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lengthDays" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "program" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "weekTitlesJson" TEXT;

-- AlterTable
ALTER TABLE "DevelopmentPathStep" ADD COLUMN     "howTo" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'TRAINING',
ADD COLUMN     "minutes" INTEGER,
ADD COLUMN     "owner" TEXT NOT NULL DEFAULT 'AGENT',
ADD COLUMN     "standardId" TEXT,
ADD COLUMN     "system" TEXT;

-- CreateTable
CREATE TABLE "AgentProgram" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "pathId" TEXT,
    "startDate" TEXT NOT NULL,
    "startDay" INTEGER NOT NULL DEFAULT 1,
    "workDaysJson" TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
    "workDaysConfirmedAt" TIMESTAMP(3),
    "daysOffJson" TEXT NOT NULL DEFAULT '[]',
    "extraDays" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startedById" TEXT,
    "stoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentProgramTask" (
    "id" TEXT NOT NULL,
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
    "doneAt" TIMESTAMP(3),
    "doneById" TEXT,
    "note" TEXT,
    "resultJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentProgramTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentProgram_profileId_key" ON "AgentProgram"("profileId");

-- CreateIndex
CREATE INDEX "AgentProgram_organizationId_status_idx" ON "AgentProgram"("organizationId", "status");

-- CreateIndex
CREATE INDEX "AgentProgramTask_programId_day_idx" ON "AgentProgramTask"("programId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProgramTask_programId_key_key" ON "AgentProgramTask"("programId", "key");

-- AddForeignKey
ALTER TABLE "AgentProgram" ADD CONSTRAINT "AgentProgram_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProgram" ADD CONSTRAINT "AgentProgram_pathId_fkey" FOREIGN KEY ("pathId") REFERENCES "DevelopmentPath"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProgramTask" ADD CONSTRAINT "AgentProgramTask_programId_fkey" FOREIGN KEY ("programId") REFERENCES "AgentProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

