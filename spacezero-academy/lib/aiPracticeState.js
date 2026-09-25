'use strict';

// The AI Practice lifecycle as the Admin sees it:
//   SOURCE -> ANALYSIS -> PRACTICE -> REVIEW -> TRAINING
// The human-readable status is DERIVED from the real records (analysis row, generated practice, background
// task, publication) instead of being stored a second time, so it cannot drift from what actually happened.
// The database keeps its detailed internal states; the UI only ever shows the words below.
const { prisma } = require('./prisma');
const { draftWhere, isTargetedRetake } = require('./courseVersions');

const STEPS = [
  { n: 1, key: 'source', label: 'Source' },
  { n: 2, key: 'analysis', label: 'Analysis' },
  { n: 3, key: 'practice', label: 'Practice' },
  { n: 4, key: 'review', label: 'Review' },
  { n: 5, key: 'training', label: 'Training' },
];

const STATES = {
  SAVED: { label: 'Saved', step: 1, tone: '' },
  ANALYZING: { label: 'Analyzing', step: 2, tone: 'badge-warning' },
  ANALYSIS_READY: { label: 'Analysis ready', step: 2, tone: 'badge-gold' },
  BUILDING: { label: 'Building practice', step: 3, tone: 'badge-warning' },
  PRACTICE_DRAFT: { label: 'Practice draft', step: 3, tone: 'badge-gold' },
  READY_FOR_REVIEW: { label: 'Ready for review', step: 4, tone: 'badge-gold' },
  APPROVED: { label: 'Approved', step: 4, tone: 'badge-success' },
  SENT: { label: 'Sent to Training', step: 5, tone: 'badge-success' },
  FAILED: { label: 'Failed', step: 2, tone: 'badge-danger' },
};

// The tabs of the AI Practice home. Few on purpose.
const TABS = [
  { key: 'all', label: 'All', states: null },
  { key: 'needs', label: 'Needs analysis', states: ['SAVED', 'FAILED'] },
  { key: 'progress', label: 'In progress', states: ['ANALYZING', 'BUILDING'] },
  { key: 'review', label: 'Ready for review', states: ['ANALYSIS_READY', 'PRACTICE_DRAFT', 'READY_FOR_REVIEW'] },
  { key: 'approved', label: 'Approved', states: ['APPROVED'] },
  { key: 'sent', label: 'Sent to Training', states: ['SENT'] },
];

const STUCK_MS = 15 * 60 * 1000; // no movement for this long while "analyzing" = offer Resume
const ANALYSIS_ACTIVE = ['QUEUED', 'EXTRACTING', 'MAPPING', 'VALIDATING'];
const ANALYSIS_STEP = { QUEUED: 0, EXTRACTING: 1, MAPPING: 2, VALIDATING: 3 };
const TYPE_LABEL = { VIDEO: 'Video', AUDIO: 'Audio', PDF: 'PDF', PPT: 'Slides', DOC: 'Document', IMAGE: 'Image', NOTE: 'Notes', LINK: 'Link', QUIZ: 'Quiz', CALL_RECORDING: 'Call' };

function stuck(updatedAt, now) { return now - new Date(updatedAt) > STUCK_MS; }

/**
 * State of a course-based source.
 * `build` = latest practice-build AiTask (or null); `components` = live practice of the version being built.
 */
function courseState(course, { build = null, components = [], now = new Date() } = {}) {
  const analysis = course.analysis || null;
  const make = (key, extra = {}) => ({ key, ...STATES[key], ...extra });
  const id = course.id;

  const sent = (course.publishedVersion || 0) > 0 && course.status !== 'DRAFT';
  const newerDraft = sent && (course.draftVersion || 1) > course.publishedVersion;
  if (sent && !newerDraft) return make('SENT', { note: `Version ${course.publishedVersion} is in Training.`, primary: { label: 'View in Training', href: `/admin/training/${id}` } });

  const versionNote = newerDraft ? `Editing version ${course.draftVersion} (version ${course.publishedVersion} stays in Training).` : null;
  const withVersion = (state) => ({ ...state, note: state.note ? `${state.note}${versionNote ? ` ${versionNote}` : ''}` : versionNote });

  if (build && (build.status === 'QUEUED' || build.status === 'RUNNING')) {
    return withVersion(make('BUILDING', { note: 'The AI is building the practice. You can leave this page — it keeps going.', primary: { label: 'View progress', href: `/ai-practice/${id}?step=practice` } }));
  }
  if (!analysis) return withVersion(make('SAVED', { note: 'Saved — not analyzed yet.', primary: { label: 'Start Analysis', href: `/ai-practice/${id}/analyze` } }));
  if (ANALYSIS_ACTIVE.includes(analysis.status)) {
    const halted = stuck(analysis.updatedAt, now);
    const done = ANALYSIS_STEP[analysis.status] === 0 ? 0 : ANALYSIS_STEP[analysis.status] - 1;
    return make('ANALYZING', {
      progress: { done, total: 3 },
      halted,
      note: halted ? 'This is taking longer than expected.' : analysis.status === 'QUEUED' ? 'Waiting to start.' : `Step ${ANALYSIS_STEP[analysis.status]} of 3.`,
      primary: halted ? { label: 'Continue', href: `/ai-practice/${id}/analysis/resume`, post: true } : { label: 'View progress', href: `/ai-practice/${id}?step=analysis` },
      ...(halted ? { remove: { label: 'Remove', href: `/ai-practice/${id}/delete`, confirm: 'Remove this? If training or skill records depend on it, it will be archived instead.' } } : {}),
    });
  }
  if (analysis.status === 'FAILED') return make('FAILED', { note: 'The analysis could not be completed. Your source is safe.', primary: { label: 'Retry', href: `/ai-practice/${id}/analysis/retry`, post: true }, remove: { label: 'Remove', href: `/ai-practice/${id}/delete`, confirm: 'Remove this? If training or skill records depend on it, it will be archived instead.' } });
  if (analysis.status === 'READY_FOR_REVIEW') return make('ANALYSIS_READY', { note: 'Review what the AI found.', primary: { label: 'Review Analysis', href: `/ai-practice/${id}?step=analysis` } });

  // analysis approved: what is the practice like?
  const live = components.filter((a) => !isTargetedRetake(a));
  const buildFailed = build && build.status === 'FAILED';
  if (!live.length) {
    if (buildFailed) return withVersion(make('FAILED', { note: 'The practice could not be built. Your analysis is safe.', primary: { label: 'Retry', href: `/ai-practice/${id}/practice/retry`, post: true }, remove: { label: 'Remove', href: `/ai-practice/${id}/delete`, confirm: 'Remove this? If training or skill records depend on it, it will be archived instead.' } }));
    return withVersion(make('ANALYSIS_READY', { note: 'Analysis approved — create the practice.', primary: { label: 'Create Practice', href: `/ai-practice/${id}?step=practice` } }));
  }
  if (live.every((a) => a.status === 'APPROVED')) return withVersion(make('APPROVED', { note: 'Approved — ready to send to Training.', primary: { label: 'Send to Training', href: `/ai-practice/${id}/send` } }));
  if (buildFailed) return withVersion(make('PRACTICE_DRAFT', { note: 'Some practice could not be built. Retry builds only what is missing.', primary: { label: 'Continue Building', href: `/ai-practice/${id}?step=practice` } }));
  return withVersion(make('READY_FOR_REVIEW', { note: 'Check the practice, preview it, then approve.', primary: { label: 'Review', href: `/ai-practice/${id}?step=review` } }));
}

/** State of a customer-call source that has not become a course yet. */
function callState(batch, now = new Date()) {
  const make = (key, extra = {}) => ({ key, ...STATES[key], ...extra });
  const id = batch.id;
  const requested = Boolean(batch.analysisRequestedAt);
  if (batch.status === 'UPLOADED' && !requested) return make('SAVED', { note: 'Saved — not analyzed yet.', primary: { label: 'Start Analysis', href: `/ai-practice/calls/${id}/analyze` } });
  if (batch.status === 'FAILED') return make('FAILED', { note: 'The analysis could not be completed. Your recordings are safe.', primary: { label: 'Retry', href: `/ai-practice/calls/${id}/retry`, post: true }, remove: { label: 'Remove', href: `/ai-practice/calls/${id}/delete`, confirm: 'Permanently delete these recordings?' } });
  if (batch.status === 'READY_FOR_REVIEW') return make('ANALYSIS_READY', { note: 'Review what the AI found in the call.', primary: { label: 'Review Analysis', href: `/ai-practice/calls/${id}` } });
  if (batch.status === 'APPROVED') return make('ANALYSIS_READY', { note: 'Analysis approved.', primary: { label: 'Review Analysis', href: `/ai-practice/calls/${id}` } });
  const total = (batch.recordings || []).length;
  const transcribed = (batch.recordings || []).filter((r) => r.status === 'TRANSCRIBED').length;
  const halted = stuck(batch.updatedAt, now) && batch.status !== 'UPLOADED';
  const done = batch.status === 'TRANSCRIBING' || batch.status === 'UPLOADED' ? 0 : batch.status === 'ANALYZING' ? 1 : 2;
  const note = batch.status === 'UPLOADED' ? 'Waiting to start.' : batch.status === 'TRANSCRIBING' ? `Transcribing — ${transcribed} of ${total} recording${total === 1 ? '' : 's'} done.` : 'Analyzing the calls.';
  return make('ANALYZING', { progress: { done, total: 3 }, halted, note: halted ? 'This is taking longer than expected.' : note, primary: halted ? { label: 'Continue', href: `/ai-practice/calls/${id}/retry`, post: true } : { label: 'View progress', href: `/ai-practice/calls/${id}` }, ...(halted ? { remove: { label: 'Remove', href: `/ai-practice/calls/${id}/delete`, confirm: 'Permanently delete these recordings?' } } : {}) });
}

function typeSummary(modules) {
  const kinds = [...new Set(modules.map((m) => TYPE_LABEL[m.contentType] || m.contentType))];
  return kinds.length ? kinds.join(' + ') : 'Material';
}

function durationSummary(modules) {
  let minutes = 0;
  for (const m of modules) {
    let ref; try { ref = m.sourceRefJson ? JSON.parse(m.sourceRefJson) : null; } catch { ref = null; }
    minutes += ref && ref.durationSeconds ? ref.durationSeconds / 60 : m.durationMinutes || 0;
  }
  return minutes >= 1 ? `${Math.round(minutes)} min` : null;
}

const shortDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** Everything the AI Practice home lists (Admin: the whole organization), newest activity first. */
async function loadSources(actor, { now = new Date(), archived = false } = {}) {
  const orgId = actor.organizationId;
  const [courses, batches] = await Promise.all([
    prisma.trainingCourse.findMany({
      where: { organizationId: orgId, origin: 'AI_PRACTICE', workspaceArchivedAt: archived ? { not: null } : null },
      include: { analysis: true, createdBy: { select: { fullName: true } }, modules: { select: { id: true, title: true, contentType: true, durationMinutes: true, sourceRefJson: true, storagePath: true, addedInVersion: true, removedInVersion: true } }, assessments: { select: { id: true, status: true, version: true, archivedAt: true, type: true, configJson: true } } },
      orderBy: { updatedAt: 'desc' }, take: 400,
    }),
    prisma.callBatch.findMany({ where: { organizationId: orgId, archivedAt: archived ? { not: null } : null }, include: { recordings: { select: { id: true, status: true, durationSeconds: true } }, uploadedBy: { select: { fullName: true } }, targetAgent: { select: { fullName: true } } }, orderBy: { updatedAt: 'desc' }, take: 300 }),
  ]);
  const tasks = courses.length ? await prisma.aiTask.findMany({ where: { courseId: { in: courses.map((c) => c.id) }, taskType: 'PRACTICE_BUILD' }, orderBy: { createdAt: 'desc' } }) : [];
  const latestBuild = new Map();
  for (const t of tasks) if (!latestBuild.has(t.courseId)) latestBuild.set(t.courseId, t);

  const genIds = batches.map((b) => b.generatedCourseId).filter(Boolean);
  const existing = new Set(genIds.length ? (await prisma.trainingCourse.findMany({ where: { id: { in: genIds } }, select: { id: true } })).map((c) => c.id) : []);
  const viaCall = new Set(genIds);
  for (const c of courses) c.modules = require('./courseVersions').modulesFor(c.modules, c.draftVersion || 1);
  const items = [];

  for (const b of batches) {
    if (b.generatedCourseId && existing.has(b.generatedCourseId)) continue; // the course below carries it and links back to the call
    const total = b.recordings.length;
    const minutes = Math.round(b.recordings.reduce((n, r) => n + (r.durationSeconds || 0), 0) / 60);
    const state = callState(b, now);
    items.push({
      kind: 'CALL', id: b.id, title: b.title || (b.purpose === 'INDIVIDUAL' && b.targetAgent ? `Call coaching — ${b.targetAgent.fullName}` : `Call recording${total === 1 ? '' : 's'}`),
      typeLabel: 'Call', meta: [minutes ? `${minutes} min` : null, total > 1 ? `${total} recordings` : null].filter(Boolean).join(' • '),
      uploadedAt: b.createdAt, uploadedBy: b.uploadedBy ? b.uploadedBy.fullName : null, fileCount: total, lastActivity: b.updatedAt,
      href: `/ai-practice/calls/${b.id}`, state, primary: state.primary, remove: state.remove, sensitive: true,
    });
  }
  for (const c of courses) {
    const components = c.assessments.filter((a) => !a.archivedAt && a.status !== 'ARCHIVED' && a.version === (c.draftVersion || 1));
    const state = courseState(c, { build: latestBuild.get(c.id) || null, components, now });
    const build = latestBuild.get(c.id);
    const last = [c.updatedAt, c.analysis && c.analysis.updatedAt, build && build.updatedAt].filter(Boolean).sort((a, b) => b - a)[0];
    items.push({
      kind: 'MATERIAL', id: c.id, title: c.title, typeLabel: typeSummary(c.modules), meta: [durationSummary(c.modules), c.modules.length > 1 ? `${c.modules.length} sources` : null].filter(Boolean).join(' • '),
      uploadedAt: c.createdAt, uploadedBy: c.createdBy ? c.createdBy.fullName : null, fileCount: c.modules.length, lastActivity: last,
      href: `/ai-practice/${c.id}`, state, primary: state.primary, remove: state.remove, viaCall: viaCall.has(c.id),
    });
  }
  return items.sort((a, b) => b.lastActivity - a.lastActivity);
}

function filterItems(items, { tab = 'all', q = '' } = {}) {
  const t = TABS.find((x) => x.key === tab) || TABS[0];
  const needle = String(q || '').trim().toLowerCase();
  return items.filter((i) => (!t.states || t.states.includes(i.state.key)) && (!needle || `${i.title} ${i.typeLabel} ${i.uploadedBy || ''}`.toLowerCase().includes(needle)));
}

function tabCounts(items) {
  return Object.fromEntries(TABS.map((t) => [t.key, t.states ? items.filter((i) => t.states.includes(i.state.key)).length : items.length]));
}

/** Components of the version being worked on, for the detail page and state. */
async function loadComponents(course) {
  return prisma.assessment.findMany({ where: draftWhere(course), include: { questions: { select: { id: true, prompt: true } } }, orderBy: { createdAt: 'asc' } });
}

module.exports = { STEPS, STATES, TABS, STUCK_MS, ANALYSIS_ACTIVE, TYPE_LABEL, courseState, callState, loadSources, filterItems, tabCounts, loadComponents, shortDate, typeSummary, durationSummary };
