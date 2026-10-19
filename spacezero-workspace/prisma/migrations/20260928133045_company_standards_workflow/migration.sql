-- CreateTable
CREATE TABLE "StandardsItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "rolesJson" TEXT,
    "quickReference" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" DATETIME,
    "currentVersionId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StandardsItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StandardsItem_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "StandardsVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StandardsVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "shortDescription" TEXT,
    "contentJson" TEXT,
    "important" BOOLEAN NOT NULL DEFAULT false,
    "requiredReading" BOOLEAN NOT NULL DEFAULT false,
    "disclosureWhenItApplies" TEXT,
    "disclosureApprovedWording" TEXT,
    "disclosureAdditionalInstructions" TEXT,
    "acknowledgementRequired" BOOLEAN NOT NULL DEFAULT false,
    "requireReacknowledgement" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedById" TEXT,
    "publishedAt" DATETIME,
    "archivedAt" DATETIME,
    CONSTRAINT "StandardsVersion_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "StandardsItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StandardsStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "versionId" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "detailJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StandardsStep_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "StandardsVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StandardsResponsibilityItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "versionId" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "text" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StandardsResponsibilityItem_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "StandardsVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StandardsAcknowledgement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "acceptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StandardsAcknowledgement_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "StandardsItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StandardsAcknowledgement_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "StandardsVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "StandardsAcknowledgement_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "StandardsItem_currentVersionId_key" ON "StandardsItem"("currentVersionId");

-- CreateIndex
CREATE INDEX "StandardsItem_organizationId_idx" ON "StandardsItem"("organizationId");

-- CreateIndex
CREATE INDEX "StandardsItem_contentType_idx" ON "StandardsItem"("contentType");

-- CreateIndex
CREATE INDEX "StandardsVersion_itemId_idx" ON "StandardsVersion"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "StandardsVersion_itemId_version_key" ON "StandardsVersion"("itemId", "version");

-- CreateIndex
CREATE INDEX "StandardsStep_versionId_idx" ON "StandardsStep"("versionId");

-- CreateIndex
CREATE INDEX "StandardsResponsibilityItem_versionId_idx" ON "StandardsResponsibilityItem"("versionId");

-- CreateIndex
CREATE INDEX "StandardsAcknowledgement_itemId_idx" ON "StandardsAcknowledgement"("itemId");

-- CreateIndex
CREATE INDEX "StandardsAcknowledgement_profileId_idx" ON "StandardsAcknowledgement"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "StandardsAcknowledgement_versionId_profileId_key" ON "StandardsAcknowledgement"("versionId", "profileId");
