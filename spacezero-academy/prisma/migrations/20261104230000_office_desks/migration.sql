-- Office Management -> Desks by team (office manager only). Computer passwords are stored encrypted.
CREATE TABLE "OfficeDesk" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OfficeDesk_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "OfficeDesk_profileId_idx" ON "OfficeDesk"("profileId");
CREATE UNIQUE INDEX "OfficeDesk_organizationId_number_key" ON "OfficeDesk"("organizationId", "number");
