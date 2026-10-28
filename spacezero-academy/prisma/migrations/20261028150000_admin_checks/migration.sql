-- Admin checks on new Travel Agents (lib/newAgentBoard.js): a supervisor's sign-off waits for an admin to confirm it,
-- the agent answers "did this happen?", and an admin can let a flag be. Adds empty (NULL) columns only; existing items
-- keep working unchanged.
-- AlterTable
ALTER TABLE "AgentProgramTask" ADD COLUMN "requestedAt" DATETIME;
ALTER TABLE "AgentProgramTask" ADD COLUMN "requestedById" TEXT;
ALTER TABLE "AgentProgramTask" ADD COLUMN "agentAnswer" TEXT;
ALTER TABLE "AgentProgramTask" ADD COLUMN "agentAnsweredAt" DATETIME;
ALTER TABLE "AgentProgramTask" ADD COLUMN "flagClearedAt" DATETIME;
ALTER TABLE "AgentProgramTask" ADD COLUMN "flagClearedById" TEXT;
