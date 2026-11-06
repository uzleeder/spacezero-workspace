-- The person closed the dashboard's "SpaceZero standard" card (its globe then turns in the sidebar logo instead).
ALTER TABLE "Profile" ADD COLUMN "heroHidden" BOOLEAN NOT NULL DEFAULT false;
