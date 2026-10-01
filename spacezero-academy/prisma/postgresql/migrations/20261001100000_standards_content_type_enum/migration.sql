-- StandardsItem.contentType was originally created as TEXT, while the
-- Prisma schema uses the StandardsContentType enum.
ALTER TABLE "StandardsItem"
ALTER COLUMN "contentType" TYPE "StandardsContentType"
USING "contentType"::"StandardsContentType";
