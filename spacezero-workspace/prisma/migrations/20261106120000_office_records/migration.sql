-- Office Management: reliable records (asset tag, model, location, lifecycle, desk link, review/verification,
-- optimistic version), a private repair queue and an activity log. Additive only: every existing item, desk, desk ID
-- and encrypted desk password is kept as it is. Asset tags/models are filled in afterwards by
-- scripts/office-backfill.cjs (dry run first; see docs/OFFICE-MANAGEMENT.md).
ALTER TABLE "OfficeItem" ADD COLUMN "assetTag" TEXT;
ALTER TABLE "OfficeItem" ADD COLUMN "model" TEXT;
ALTER TABLE "OfficeItem" ADD COLUMN "location" TEXT;
ALTER TABLE "OfficeItem" ADD COLUMN "lifecycle" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "OfficeItem" ADD COLUMN "deskId" TEXT REFERENCES "OfficeDesk" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OfficeItem" ADD COLUMN "verifiedAt" DATETIME;
ALTER TABLE "OfficeItem" ADD COLUMN "needsReview" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OfficeItem" ADD COLUMN "retiredAt" DATETIME;
ALTER TABLE "OfficeItem" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "OfficeItem_organizationId_assetTag_key" ON "OfficeItem"("organizationId", "assetTag");
CREATE INDEX "OfficeItem_deskId_idx" ON "OfficeItem"("deskId");

ALTER TABLE "OfficeDesk" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "OfficeRepair" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "deskId" TEXT,
    "issue" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "responsible" TEXT,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" DATETIME,
    "notes" TEXT,
    "resolution" TEXT,
    "resolvedAt" DATETIME,
    "resultingCondition" TEXT,
    "resultingLifecycle" TEXT,
    "createdById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OfficeRepair_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "OfficeItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OfficeRepair_organizationId_status_idx" ON "OfficeRepair"("organizationId", "status");
CREATE INDEX "OfficeRepair_itemId_idx" ON "OfficeRepair"("itemId");

CREATE TABLE "OfficeActivity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "itemId" TEXT,
    "deskId" TEXT,
    "repairId" TEXT,
    "action" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "actorId" TEXT,
    "actorName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OfficeActivity_organizationId_createdAt_idx" ON "OfficeActivity"("organizationId", "createdAt");
CREATE INDEX "OfficeActivity_itemId_idx" ON "OfficeActivity"("itemId");
