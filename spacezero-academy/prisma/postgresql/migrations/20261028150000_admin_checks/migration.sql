-- Admin checks on new Travel Agents (lib/newAgentBoard.js): a supervisor's sign-off waits for an admin to confirm it,
-- the agent answers "did this happen?", and an admin can let a flag be. Adds empty (NULL) columns only; existing items
-- keep working unchanged.
-- AlterTable
ALTER TABLE "AgentProgramTask" ADD COLUMN     "requestedAt" TIMESTAMP(3),
ADD COLUMN     "requestedById" TEXT,
ADD COLUMN     "agentAnswer" TEXT,
ADD COLUMN     "agentAnsweredAt" TIMESTAMP(3),
ADD COLUMN     "flagClearedAt" TIMESTAMP(3),
ADD COLUMN     "flagClearedById" TEXT;
