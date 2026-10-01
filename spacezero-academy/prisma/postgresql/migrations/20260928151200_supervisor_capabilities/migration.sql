-- CreateTable
CREATE TABLE "SupervisorCapability" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "supervisorId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupervisorCapability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupervisorCapability_supervisorId_idx" ON "SupervisorCapability"("supervisorId");

-- CreateIndex
CREATE UNIQUE INDEX "SupervisorCapability_organizationId_supervisorId_key_key" ON "SupervisorCapability"("organizationId", "supervisorId", "key");

-- AddForeignKey
ALTER TABLE "SupervisorCapability" ADD CONSTRAINT "SupervisorCapability_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupervisorCapability" ADD CONSTRAINT "SupervisorCapability_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
