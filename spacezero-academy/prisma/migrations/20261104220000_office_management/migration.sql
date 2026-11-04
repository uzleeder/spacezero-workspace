-- Office Management: the office items, managed only by the office manager (Fred Marco).
ALTER TABLE "Profile" ADD COLUMN "officeManager" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "OfficeItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'OTHER',
    "holderId" TEXT,
    "condition" TEXT NOT NULL DEFAULT 'GOOD',
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OfficeItem_holderId_fkey" FOREIGN KEY ("holderId") REFERENCES "Profile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "OfficeItem_organizationId_idx" ON "OfficeItem"("organizationId");
CREATE INDEX "OfficeItem_holderId_idx" ON "OfficeItem"("holderId");

-- Fred Marco is the office manager.
UPDATE "Profile" SET "officeManager" = true WHERE "username" = 'fred' OR "fullName" = 'Fred Marco';
