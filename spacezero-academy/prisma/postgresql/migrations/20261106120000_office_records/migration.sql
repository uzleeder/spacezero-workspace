-- AlterTable
ALTER TABLE "OfficeItem" ADD COLUMN     "assetTag" TEXT,
ADD COLUMN     "deskId" TEXT,
ADD COLUMN     "lifecycle" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "location" TEXT,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "needsReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "retiredAt" TIMESTAMP(3),
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "OfficeDesk" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "OfficeRepair" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "deskId" TEXT,
    "issue" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "responsible" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3),
    "notes" TEXT,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resultingCondition" TEXT,
    "resultingLifecycle" TEXT,
    "createdById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficeRepair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfficeActivity" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfficeActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfficeRepair_organizationId_status_idx" ON "OfficeRepair"("organizationId", "status");

-- CreateIndex
CREATE INDEX "OfficeRepair_itemId_idx" ON "OfficeRepair"("itemId");

-- CreateIndex
CREATE INDEX "OfficeActivity_organizationId_createdAt_idx" ON "OfficeActivity"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "OfficeActivity_itemId_idx" ON "OfficeActivity"("itemId");

-- CreateIndex
CREATE INDEX "OfficeItem_deskId_idx" ON "OfficeItem"("deskId");

-- CreateIndex
CREATE UNIQUE INDEX "OfficeItem_organizationId_assetTag_key" ON "OfficeItem"("organizationId", "assetTag");

-- AddForeignKey
ALTER TABLE "OfficeItem" ADD CONSTRAINT "OfficeItem_deskId_fkey" FOREIGN KEY ("deskId") REFERENCES "OfficeDesk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficeRepair" ADD CONSTRAINT "OfficeRepair_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "OfficeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

