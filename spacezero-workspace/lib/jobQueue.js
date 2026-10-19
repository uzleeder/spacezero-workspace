'use strict';

// Lightweight in-process background job runner. No external queue/infra (no Redis/BullMQ) —
// a single setInterval poller checks each registered job type for one row to process, so
// Gemini call concurrency stays bounded to one job at a time across the whole process.
//
// Documented limitation: durability is DB-row-only (status/retryCount/errorMessage columns),
// not an in-memory queue. A server restart mid-processing leaves a row in a non-terminal
// state (e.g. EXTRACTING); requeueStuckJobs() resets any row idle in a processing state for
// longer than STUCK_AFTER_MS back to its queued state on the next tick, so it gets retried
// rather than stuck forever. This trades perfect durability for zero added infrastructure.

const POLL_INTERVAL_MS = Number(process.env.JOB_POLL_INTERVAL_MS) || 5000;
const MAX_RETRIES = 3;
const STUCK_AFTER_MS = 10 * 60 * 1000; // 10 minutes in a non-terminal processing state = stuck

const registrations = [];
let timer = null;
let ticking = false;

/**
 * Registers a job type with the poller.
 * @param {string} name - for logging
 * @param {() => Promise<{id: string, run: () => Promise<void>} | null>} findNext - returns the
 *   next unit of work (or null if none pending). `run()` must leave the underlying row in a
 *   terminal state, or QUEUED with an incremented retry count, even on failure.
 * @param {() => Promise<void>} [requeueStuck] - resets any rows stuck in a processing state.
 */
function registerJobType({ name, findNext, requeueStuck }) {
  registrations.push({ name, findNext, requeueStuck });
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (const job of registrations) {
      try {
        if (job.requeueStuck) await job.requeueStuck();
      } catch (err) {
        console.error(`[jobQueue] ${job.name} requeueStuck error:`, err.message || err);
      }
      try {
        const next = await job.findNext();
        if (next) await next.run();
      } catch (err) {
        console.error(`[jobQueue] ${job.name} job failed:`, err.message || err);
      }
    }
  } finally {
    ticking = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => console.error('[jobQueue] tick error:', err));
  }, POLL_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { registerJobType, start, stop, tick, MAX_RETRIES, STUCK_AFTER_MS };
