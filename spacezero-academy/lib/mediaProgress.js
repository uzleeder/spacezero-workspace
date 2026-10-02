'use strict';
const { prisma } = require('./prisma');
const MEDIA_TYPES = ['VIDEO', 'AUDIO', 'CALL_RECORDING'];
// Material that is read rather than played: it counts once the learner has opened it, spent a little time with it and confirmed.
const DOC_TYPES = ['PDF', 'PPT', 'DOC', 'IMAGE', 'NOTE', 'LINK'];
const MIN_READ_MS = Number(process.env.MIN_READ_MS) || 12000;

/** Material a learner can actually consume (an empty placeholder can never block anybody). */
function consumable(m) {
  if (MEDIA_TYPES.includes(m.contentType)) return Boolean(m.storagePath);
  if (m.contentType === 'NOTE') return Boolean((m.description || '').trim());
  if (DOC_TYPES.includes(m.contentType)) return Boolean(m.storagePath || m.externalUrl);
  return false;
}
function durationOf(module) {
  try { return Number(JSON.parse(module.sourceRefJson || '{}').durationSeconds) || 0; } catch { return 0; }
}
async function mediaGate(profileId, courseId, version = null) {
  const { modulesFor, learnerVersion } = require('./courseVersions');
  const course = await prisma.trainingCourse.findUnique({ where: { id: courseId }, include: { modules: { include: { mediaProgress: { where: { profileId } } } } } });
  if (!course) return { unlocked: false, modules: [], done: 0, total: 0 };
  // Each learner is held to the material of the version they were assigned, never a later one.
  // Learn first, practise after: every required video, recording, document, slide deck, image or note must be
  // finished before ANY practice, quiz or assessment of the training opens.
  const v = version || await learnerVersion(profileId, courseId, course);
  const required = modulesFor(course.modules, v).filter((m) => m.required && consumable(m));
  const finished = (m) => Boolean(m.mediaProgress[0]?.completedAt) && (!MEDIA_TYPES.includes(m.contentType) || durationOf(m) > 0);
  const done = required.filter(finished).length;
  return { unlocked: done === required.length, modules: required, done, total: required.length, finished };
}
function advanceProgress(row, { position, speed, action }, duration, now = new Date()) {
  if (!Number.isFinite(position) || position < 0 || position > duration + .5 || !Number.isFinite(speed) || speed < .25 || speed > 1.2) throw new Error('Invalid playback position or speed.');
  const ranges = JSON.parse(row.watchedRangesJson || '[]');
  const frontier = ranges.length ? ranges[0][1] : 0;
  const elapsed = Math.min(15, Math.max(0, (now - row.lastActivityAt) / 1000));
  if (position > frontier + elapsed * 1.2 + .5 || (action === 'start' && position > frontier + .5)) throw new Error('Continue from the last watched position.');
  const end = action === 'start' ? frontier : Math.min(duration, Math.max(frontier, position));
  // Required material counts as watched at 70% of its duration, not only at the very end — the
  // anti-skip rules above (no forward jumps, capped speed) already guarantee that 70% was actually
  // played through in order, so the remaining stretch is not worth blocking a learner who got there.
  const COMPLETION_FRACTION = 0.7;
  return { watchedRangesJson: JSON.stringify([[0, end]]), lastPositionSeconds: Math.min(position, duration), playbackSpeed: speed, percentComplete: Math.min(100, end / duration * 100), lastActivityAt: now, completedAt: end >= duration * COMPLETION_FRACTION ? (row.completedAt || now) : null };
}
module.exports = { MEDIA_TYPES, DOC_TYPES, MIN_READ_MS, consumable, durationOf, mediaGate, advanceProgress };
