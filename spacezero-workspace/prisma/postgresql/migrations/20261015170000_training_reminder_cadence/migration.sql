-- Existing accepted assignment emails adopt the six-hour cadence. Do not create
-- new schedules or alter an in-flight/retrying message's payload or lease.
-- Completed/ineligible recipients are rechecked by the worker before any send.
UPDATE "TrainingEmailSchedule"
SET "nextSendAt" = "lastSentAt" + INTERVAL '6 hours'
WHERE "kind" = 'REMINDER'
  AND "lastSentAt" IS NOT NULL
  AND "claimToken" IS NULL
  AND "payloadJson" IS NULL
  AND "retryCount" = 0
  AND "lastError" IS NULL;
