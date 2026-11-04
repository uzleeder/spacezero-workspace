-- CreateTable
CREATE TABLE "OfficeDesk" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "team" TEXT,
    "profileId" TEXT,
    "personName" TEXT,
    "monitor" TEXT,
    "pcCase" TEXT,
    "keyboard" TEXT,
    "mouse" TEXT,
    "headphone" TEXT,
    "passwordEnc" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficeDesk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfficeDesk_profileId_idx" ON "OfficeDesk"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "OfficeDesk_organizationId_number_key" ON "OfficeDesk"("organizationId", "number");

-- AddForeignKey
ALTER TABLE "OfficeDesk" ADD CONSTRAINT "OfficeDesk_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

