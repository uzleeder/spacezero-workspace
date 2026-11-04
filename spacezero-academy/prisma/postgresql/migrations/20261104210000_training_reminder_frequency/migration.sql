-- How often each training reminds (Manage Training -> Training emails). Existing trainings keep the daily reminder.
ALTER TABLE "TrainingCourse" ADD COLUMN "reminderEveryDays" INTEGER NOT NULL DEFAULT 1;
