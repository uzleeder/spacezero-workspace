-- Call Practice: real client calls new agents listen to and type out, word for word (Manage Training -> Call Practice).
-- CreateTable
CREATE TABLE "PracticeCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "durationSeconds" REAL NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "referenceText" TEXT,
    "referenceStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "referenceError" TEXT,
    "createdById" TEXT NOT NULL,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PracticeCallTranscript" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "callId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "watchedRangesJson" TEXT NOT NULL DEFAULT '[]',
    "lastPositionSeconds" REAL NOT NULL DEFAULT 0,
    "playbackSpeed" REAL NOT NULL DEFAULT 1,
    "listenActivityAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "listenedAt" DATETIME,
    "draftText" TEXT NOT NULL DEFAULT '',
    "typingSeconds" REAL NOT NULL DEFAULT 0,
    "draftSavedAt" DATETIME,
    "submittedText" TEXT,
    "submittedAt" DATETIME,
    "wordCount" INTEGER,
    "accuracy" REAL,
    "wordsPerMinute" REAL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PracticeCallTranscript_callId_fkey" FOREIGN KEY ("callId") REFERENCES "PracticeCall" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PracticeCallTranscript_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PracticeCall_organizationId_displayOrder_idx" ON "PracticeCall"("organizationId", "displayOrder");

-- CreateIndex
CREATE INDEX "PracticeCall_referenceStatus_idx" ON "PracticeCall"("referenceStatus");

-- CreateIndex
CREATE INDEX "PracticeCallTranscript_callId_idx" ON "PracticeCallTranscript"("callId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeCallTranscript_profileId_callId_key" ON "PracticeCallTranscript"("profileId", "callId");
