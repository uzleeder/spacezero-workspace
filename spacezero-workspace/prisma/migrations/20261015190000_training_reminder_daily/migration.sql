-- Training reminders now go out once a day (24 hours), not every 6 hours. Every existing reminder schedule (including
-- those without a deadline, which used to stop) adopts the new interval. In-flight or retrying messages (claimed, with a payload, or with
-- errors) are left alone, and no new schedules are created.
UPDATE "TrainingEmailSchedule"
SET "nextSendAt" = "lastSentAt" + 86400000
WHERE "kind" = 'REMINDER'
  AND "lastSentAt" IS NOT NULL
  AND "claimToken" IS NULL
  AND "payloadJson" IS NULL
  AND "retryCount" = 0
  AND "lastError" IS NULL;
