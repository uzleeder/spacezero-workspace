-- CreateTable
CREATE TABLE "StandardsItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "rolesJson" TEXT,
    "quickReference" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "currentVersionId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StandardsItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StandardsVersion" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "StandardsVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StandardsStep" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "detailJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StandardsStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StandardsResponsibilityItem" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StandardsResponsibilityItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StandardsAcknowledgement" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StandardsAcknowledgement_pkey" PRIMARY KEY ("id")
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

-- AddForeignKey
ALTER TABLE "StandardsItem" ADD CONSTRAINT "StandardsItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandardsItem" ADD CONSTRAINT "StandardsItem_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "StandardsVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandardsVersion" ADD CONSTRAINT "StandardsVersion_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "StandardsItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandardsStep" ADD CONSTRAINT "StandardsStep_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "StandardsVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandardsResponsibilityItem" ADD CONSTRAINT "StandardsResponsibilityItem_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "StandardsVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandardsAcknowledgement" ADD CONSTRAINT "StandardsAcknowledgement_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "StandardsItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandardsAcknowledgement" ADD CONSTRAINT "StandardsAcknowledgement_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "StandardsVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandardsAcknowledgement" ADD CONSTRAINT "StandardsAcknowledgement_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
