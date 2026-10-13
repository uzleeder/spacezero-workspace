CREATE TABLE "TrainingEmailSchedule" (
    "recipientId" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL DEFAULT 'ASSIGNED',
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "nextSendAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "assignmentSentAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "payloadJson" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TrainingEmailSchedule_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "TrainingAssignmentRecipient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TrainingEmailSchedule_nextSendAt_idx" ON "TrainingEmailSchedule"("nextSendAt");
