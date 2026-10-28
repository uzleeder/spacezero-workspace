-- New Travel Agent path (lib/newAgentProgram.js onTravelPath): the ramp after the 4 weeks, the "Ready for solo live
-- calls" gate and Call Practice repeats. Adds columns with defaults only; existing rows keep working unchanged.
-- AlterTable
ALTER TABLE "DevelopmentPath" ADD COLUMN     "rampWeeks" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN     "rampCallsPerDay" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "readyAccuracy" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "readyCalls" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "readyWpm" INTEGER NOT NULL DEFAULT 35,
ADD COLUMN     "prestartSeeded" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AgentProgram" ADD COLUMN     "rampExtraDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT;

-- AlterTable: every existing transcript becomes attempt 1
ALTER TABLE "PracticeCallTranscript" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 1;

-- DropIndex
DROP INDEX "PracticeCallTranscript_profileId_callId_key";

-- CreateIndex
CREATE UNIQUE INDEX "PracticeCallTranscript_profileId_callId_attempt_key" ON "PracticeCallTranscript"("profileId", "callId", "attempt");
