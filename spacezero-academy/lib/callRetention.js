'use strict';

// Configurable retention and deletion for customer calls (spec section 12). An Admin sets
// "calls.retentionDays" in Settings & Security (0 = keep until deleted by hand). Expired batches
// that have finished processing lose their recordings, transcripts and analysis; training that was
// already approved from them is a separate course and is not touched.
const fs = require('fs/promises');
const { prisma } = require('./prisma');
const { getSetting } = require('./orgSettings');
const { resolveStoragePath } = require('./storage');
const { logAudit } = require('./audit');
const { registerJobType } = require('./jobQueue');

const FINISHED = ['FAILED', 'READY_FOR_REVIEW', 'APPROVED'];

async function deleteBatchFiles(batch) {
  for (const recording of batch.recordings) {
    await fs.unlink(resolveStoragePath(recording.storagePath)).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  }
}

/** Deletes finished call batches older than the organization's retention period. Returns how many. */
async function purgeExpiredCalls(organizationId, { actorId = null, now = new Date() } = {}) {
  const days = await getSetting(organizationId, 'calls.retentionDays');
  if (!days) return 0;
  const cutoff = new Date(now.getTime() - days * 86400000);
  const expired = await prisma.callBatch.findMany({ where: { organizationId, status: { in: FINISHED }, createdAt: { lt: cutoff } }, include: { recordings: true } });
  for (const batch of expired) {
    await deleteBatchFiles(batch);
    await prisma.callBatch.delete({ where: { id: batch.id } });
  }
  if (expired.length) await logAudit({ organizationId, actorId, action: 'calls.retention_purged', targetTable: 'CallBatch', metadata: { count: expired.length, retentionDays: days } });
  return expired.length;
}

// Runs once every six hours from the in-process job poller (never in tests).
const EVERY_MS = 6 * 60 * 60 * 1000;
let lastRun = 0;
registerJobType({
  name: 'callRetention',
  async findNext() {
    if (Date.now() - lastRun < EVERY_MS) return null;
    lastRun = Date.now();
    return {
      id: 'call-retention',
      run: async () => {
        const settings = await prisma.orgSetting.findMany({ where: { key: 'calls.retentionDays' }, select: { organizationId: true } });
        for (const { organizationId } of settings) await purgeExpiredCalls(organizationId);
      },
    };
  },
  async requeueStuck() {},
});

module.exports = { purgeExpiredCalls };