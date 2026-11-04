-- Call Practice: real client calls new agents listen to and type out, word for word (Manage Training -> Call Practice).
-- CreateTable
CREATE TABLE "PracticeCall" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "durationSeconds" DOUBLE PRECISION NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "referenceText" TEXT,
    "referenceStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "referenceError" TEXT,
    "createdById" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeCallTranscript" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "watchedRangesJson" TEXT NOT NULL DEFAULT '[]',
    "lastPositionSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "playbackSpeed" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "listenActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "listenedAt" TIMESTAMP(3),
    "draftText" TEXT NOT NULL DEFAULT '',
    "typingSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "draftSavedAt" TIMESTAMP(3),
    "submittedText" TEXT,
    "submittedAt" TIMESTAMP(3),
    "wordCount" INTEGER,
    "accuracy" DOUBLE PRECISION,
    "wordsPerMinute" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PracticeCallTranscript_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PracticeCall_organizationId_displayOrder_idx" ON "PracticeCall"("organizationId", "displayOrder");

-- CreateIndex
CREATE INDEX "PracticeCall_referenceStatus_idx" ON "PracticeCall"("referenceStatus");

-- CreateIndex
CREATE INDEX "PracticeCallTranscript_callId_idx" ON "PracticeCallTranscript"("callId");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeCallTranscript_profileId_callId_key" ON "PracticeCallTranscript"("profileId", "callId");

-- AddForeignKey
ALTER TABLE "PracticeCallTranscript" ADD CONSTRAINT "PracticeCallTranscript_callId_fkey" FOREIGN KEY ("callId") REFERENCES "PracticeCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeCallTranscript" ADD CONSTRAINT "PracticeCallTranscript_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
