ALTER TABLE "AiChat" ADD COLUMN "isPinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiChat" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiChatMessage" ADD COLUMN "imagePath" TEXT;
ALTER TABLE "AiChatMessage" ADD COLUMN "imageMime" TEXT;
ALTER TABLE "AiChatMessage" ADD COLUMN "imageName" TEXT;
ALTER TABLE "AiChatMessage" ADD COLUMN "sourcesJson" TEXT NOT NULL DEFAULT '[]';
CREATE TABLE "AiChatShare" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "token" TEXT NOT NULL,
  "chatId" TEXT NOT NULL,
  "recipientIdsJson" TEXT NOT NULL,
  "snapshotJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiChatShare_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "AiChat"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AiChatShare_token_key" ON "AiChatShare"("token");
CREATE INDEX "AiChatShare_chatId_idx" ON "AiChatShare"("chatId");
