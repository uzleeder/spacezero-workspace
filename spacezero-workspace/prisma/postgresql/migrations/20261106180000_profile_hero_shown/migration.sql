-- By default the dashboard's "SpaceZero standard" globe turns in the sidebar logo; heroShown is set by someone who
-- brings the card back onto their dashboard (and cleared again by its X).
ALTER TABLE "Profile" ADD COLUMN "heroShown" BOOLEAN NOT NULL DEFAULT false;
