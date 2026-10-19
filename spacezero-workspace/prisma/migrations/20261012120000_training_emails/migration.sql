CREATE TABLE "TrainingEmailSchedule" (
    "recipientId" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL DEFAULT 'ASSIGNED',
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "nextSendAt" DATETIME,
    "lastSentAt" DATETIME,
    "assignmentSentAt" DATETIME,
    "claimToken" TEXT,
    "claimedAt" DATETIME,
    "payloadJson" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TrainingEmailSchedule_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "TrainingAssignmentRecipient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TrainingEmailSchedule_nextSendAt_idx" ON "TrainingEmailSchedule"("nextSendAt");
