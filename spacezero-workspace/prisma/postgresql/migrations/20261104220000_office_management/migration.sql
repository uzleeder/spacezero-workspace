-- Office Management: the office items, managed only by the office manager (Fred Marco).
-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "officeManager" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OfficeItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'OTHER',
    "holderId" TEXT,
    "condition" TEXT NOT NULL DEFAULT 'GOOD',
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficeItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfficeItem_organizationId_idx" ON "OfficeItem"("organizationId");

-- CreateIndex
CREATE INDEX "OfficeItem_holderId_idx" ON "OfficeItem"("holderId");

-- AddForeignKey
ALTER TABLE "OfficeItem" ADD CONSTRAINT "OfficeItem_holderId_fkey" FOREIGN KEY ("holderId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Fred Marco is the office manager.
UPDATE "Profile" SET "officeManager" = true WHERE "username" = 'fred' OR "fullName" = 'Fred Marco';
