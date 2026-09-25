'use strict';

// AI Practice = the creation factory. Every piece of raw material (a call batch, or a set of
// uploaded training sources) moves through ONE visible workflow:
//   UPLOADED -> PROCESSING -> PRACTICE_GENERATED -> READY_FOR_REVIEW -> APPROVED -> SENT_TO_TRAINING
// The stage is DERIVED from the real underlying records (call batch status, course analysis,
// generated assessments, course publication) rather than stored a second time, so it can never
// drift out of sync with what actually happened.
const { prisma } = require('./prisma');

const STAGES = ['UPLOADED', 'PROCESSING', 'PRACTICE_GENERATED', 'READY_FOR_REVIEW', 'APPROVED', 'SENT_TO_TRAINING'];
const STAGE_LABEL = {
  UPLOADED: 'Uploaded',
  PROCESSING: 'Processing / analyzing',
  PRACTICE_GENERATED: 'Practice generated',
  READY_FOR_REVIEW: 'Ready for review',
  APPROVED: 'Approved',
  SENT_TO_TRAINING: 'Sent to Training',
};
// The section tabs on the hub. UPLOADED and PROCESSING share "Processing" so nothing sits unseen.
const SECTIONS = [
  { key: 'all', label: 'All work', stages: STAGES },
  { key: 'processing', label: 'Processing', stages: ['UPLOADED', 'PROCESSING'] },
  { key: 'draft', label: 'Draft Practices', stages: ['PRACTICE_GENERATED'] },
  { key: 'review', label: 'Ready for Review', stages: ['READY_FOR_REVIEW'] },
  { key: 'approved', label: 'Approved / Ready', stages: ['APPROVED'] },
  { key: 'sent', label: 'Sent to Training', stages: ['SENT_TO_TRAINING'] },
];

const CALL_STAGE = {
  UPLOADED: 'UPLOADED',
  TRANSCRIBING: 'PROCESSING',
  ANALYZING: 'PROCESSING',
  AGGREGATING: 'PROCESSING',
  GENERATING_PRACTICE: 'PRACTICE_GENERATED',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  FAILED: 'PROCESSING',
};

/** Stage of a course-based work item (uploaded training sources -> analysis -> practice -> catalog). */
function courseStage(course) {
  if (course.status === 'PUBLISHED') return { stage: 'SENT_TO_TRAINING', note: null, failed: false };
  const analysis = course.analysis;
  if (!analysis) return { stage: 'UPLOADED', note: 'Sources uploaded — start the AI analysis.', failed: false };
  if (analysis.status === 'FAILED') return { stage: 'PROCESSING', note: 'Analysis failed — open to retry.', failed: true };
  if (analysis.status === 'QUEUED') return { stage: 'UPLOADED', note: 'Queued for analysis.', failed: false };
  if (['EXTRACTING', 'MAPPING', 'VALIDATING'].includes(analysis.status)) return { stage: 'PROCESSING', note: 'AI is analyzing the material.', failed: false };
  if (analysis.status === 'READY_FOR_REVIEW') return { stage: 'READY_FOR_REVIEW', note: 'Review the AI analysis and approve it.', failed: false };

  const live = (course.assessments || []).filter((a) => !a.archivedAt && a.status !== 'ARCHIVED');
  if (!live.length) return { stage: 'PRACTICE_GENERATED', note: 'Analysis approved — generate practice.', failed: false };
  if (live.some((a) => a.status !== 'APPROVED')) return { stage: 'READY_FOR_REVIEW', note: 'Review and approve the generated practice.', failed: false };
  return { stage: 'APPROVED', note: 'Approved — send it to Training.', failed: false };
}

function callStage(batch) {
  const derived = CALL_STAGE[batch.status];
  if (batch.status === 'APPROVED') return null; // the generated course carries it from here
  return { stage: derived, note: batch.status === 'FAILED' ? 'Processing failed — open to retry.' : null, failed: batch.status === 'FAILED' };
}

/**
 * All AI Practice work items the actor may see, newest first. Admin: whole organization.
 * Supervisor: only what they created/uploaded.
 */
async function loadWorkItems(actor) {
  const own = actor.role === 'ADMIN' ? {} : { createdById: actor.id };
  const ownBatch = actor.role === 'ADMIN' ? {} : { uploadedById: actor.id };

  const [batches, courses] = await Promise.all([
    prisma.callBatch.findMany({ where: { organizationId: actor.organizationId, ...ownBatch }, include: { targetAgent: { select: { fullName: true } }, recordings: { select: { id: true } } }, orderBy: { createdAt: 'desc' }, take: 200 }),
    prisma.trainingCourse.findMany({ where: { organizationId: actor.organizationId, archivedAt: null, ...own }, include: { analysis: true, assessments: { select: { id: true, status: true, archivedAt: true } }, modules: { select: { id: true } } }, orderBy: { createdAt: 'desc' }, take: 300 }),
  ]);

  const courseById = new Map(courses.map((c) => [c.id, c]));
  const claimed = new Set();
  const items = [];

  for (const batch of batches) {
    const linked = batch.generatedCourseId ? courseById.get(batch.generatedCourseId) : null;
    if (linked) claimed.add(linked.id);
    const derived = linked ? courseStage(linked) : callStage(batch);
    if (!derived) continue; // approved batch whose course belongs to another creator's scope
    items.push({
      kind: 'CALL',
      id: batch.id,
      title: batch.mode === 'BEST_PRACTICE' ? 'Best-practice call' : `Call coaching — ${batch.targetAgent ? batch.targetAgent.fullName : 'employee'}`,
      subtitle: `${batch.recordings.length} recording${batch.recordings.length === 1 ? '' : 's'} · ${batch.mode === 'BEST_PRACTICE' ? 'reusable training call' : 'individual improvement'}`,
      href: linked ? `/admin/training/${linked.id}` : `/ai-practice/calls/${batch.id}`,
      secondaryHref: linked ? `/ai-practice/calls/${batch.id}` : null,
      createdAt: batch.createdAt,
      ...derived,
    });
  }

  for (const course of courses) {
    if (claimed.has(course.id)) continue;
    const derived = courseStage(course);
    // Plain hand-built courses published long ago live in the Training catalog, not in this factory view.
    if (derived.stage === 'SENT_TO_TRAINING' && !course.analysis && !course.assessments.length) continue;
    items.push({
      kind: 'MATERIAL',
      id: course.id,
      title: course.title,
      subtitle: `${course.modules.length} source${course.modules.length === 1 ? '' : 's'} · ${course.assessments.filter((a) => !a.archivedAt).length} practice${course.assessments.length === 1 ? '' : 's'}`,
      href: `/admin/training/${course.id}`,
      secondaryHref: null,
      createdAt: course.createdAt,
      ...derived,
    });
  }

  return items.sort((a, b) => b.createdAt - a.createdAt);
}

module.exports = { STAGES, STAGE_LABEL, SECTIONS, courseStage, callStage, loadWorkItems };
