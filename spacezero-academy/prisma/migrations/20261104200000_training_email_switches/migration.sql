-- Admin switches for training emails (Manage Training -> Training emails). Additive: existing teams and trainings keep emails on.
ALTER TABLE "Team" ADD COLUMN "trainingEmailsOff" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TrainingCourse" ADD COLUMN "trainingEmailsOff" BOOLEAN NOT NULL DEFAULT false;
