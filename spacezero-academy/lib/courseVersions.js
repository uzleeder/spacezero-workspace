'use strict';

// Versioning and "Send to Training" for AI Practice packages.
//
// One TrainingCourse row is the source project, its practice package and (once sent) the Training catalog
// entry, so sending can never leave a disconnected copy. What changes over time is the VERSION of the practice:
//   * draftVersion     - the version being built/edited in AI Practice
//   * publishedVersion - the version most recently sent to Training (0 = never sent)
// Assessments carry `version`. An assessment that belongs to a version <= publishedVersion is IMMUTABLE: later
// improvements happen in a new draft version. Learners keep the version they were assigned
// (TrainingAssignment.courseVersion), so nothing changes under an assigned or completed training.
const { prisma } = require('./prisma');
const { logAudit } = require('./audit');
const { getSetting } = require('./orgSettings');
const { createNotification } = require('./notifications');

const safe = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const isTargetedRetake = (a) => safe(a.configJson, {}) && safe(a.configJson, {}).targetedRetake === true;

/** The learning material of one version: added on or before it and not yet removed. */
const modulesFor = (modules, version) => (modules || []).filter((m) => (m.addedInVersion || 1) <= version && (m.removedInVersion == null || m.removedInVersion > version));

/** Which version of a course a person was assigned (their latest assignment), or the live one. */
async function learnerVersion(profileId, courseId, course = null) {
  const mine = await prisma.trainingAssignment.findFirst({ where: { courseId, recipients: { some: { profileId } } }, orderBy: { createdAt: 'desc' }, select: { courseVersion: true } });
  if (mine) return mine.courseVersion;
  const c = course || await prisma.trainingCourse.findUnique({ where: { id: courseId }, select: { publishedVersion: true } });
  return Math.max(1, (c && c.publishedVersion) || 0);
}

/** The version new assignments receive (and the one Training shows). */
const liveVersion = (course) => Math.max(1, course.publishedVersion || 0);

/** Where-clause for the assessments of the version being worked on in AI Practice. */
const draftWhere = (course) => ({ courseId: course.id, version: course.draftVersion || 1, archivedAt: null, status: { not: 'ARCHIVED' } });

/** Where-clause for the assessments of the version employees are assigned today. */
const publishedWhere = (course) => ({ courseId: course.id, version: liveVersion(course), archivedAt: null, status: 'APPROVED' });

/** The package = the working set of practice components (per-learner targeted retakes are not part of it). */
async function packageComponents(course) {
  const rows = await prisma.assessment.findMany({ where: draftWhere(course), include: { questions: { select: { id: true } } }, orderBy: { createdAt: 'asc' } });
  return rows.filter((a) => !isTargetedRetake(a));
}

/** Why an assessment may not be edited in place (null = editable). */
function lockReason(assessment) {
  const course = assessment.course;
  if (!course || !course.publishedVersion) return null;
  if ((assessment.version || 1) <= course.publishedVersion) {
    return `This practice belongs to version ${assessment.version || 1}, which was sent to Training. Create a new version in AI Practice to change it — assigned and completed training stays exactly as it was.`;
  }
  return null;
}

// ------------------------------------------------------------------ package approval
/** Approves every live component of the draft version at once (individual approval still exists on each component). */
async function approvePackage(actor, course) {
  const components = await prisma.assessment.findMany({ where: draftWhere(course), include: { questions: { select: { id: true } } } });
  const real = components.filter((a) => !isTargetedRetake(a));
  if (!real.length) return { ok: false, error: 'There is no practice to approve yet.' };
  const empty = real.filter((a) => ['QUIZ', 'TECHNICAL', 'PRODUCT_KNOWLEDGE'].includes(a.type) && a.questions.length === 0);
  if (empty.length) return { ok: false, error: `Add at least one question to "${empty[0].title}" (or remove it) before approving.` };
  const pending = real.filter((a) => a.status !== 'APPROVED');
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const a of pending) await tx.assessment.update({ where: { id: a.id }, data: { status: 'APPROVED', approvedById: actor.id, approvedAt: now } });
    await tx.trainingVersion.upsert({ where: { courseId_version: { courseId: course.id, version: course.draftVersion } }, update: { approvedById: actor.id, approvedAt: now }, create: { courseId: course.id, version: course.draftVersion, status: 'DRAFT', approvedById: actor.id, approvedAt: now, createdById: actor.id } });
  });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'practice.package_approved', targetTable: 'TrainingCourse', targetId: course.id, metadata: { version: course.draftVersion, components: real.length, newlyApproved: pending.length } });
  return { ok: true, approved: pending.length };
}

/** Takes an approved package back to draft (only for a version that has not been sent to Training). */
async function revokeApproval(actor, course) {
  if ((course.draftVersion || 1) <= (course.publishedVersion || 0)) return { ok: false, error: 'This version was already sent to Training. Create a new version to change it.' };
  const changed = await prisma.assessment.updateMany({ where: { ...draftWhere(course), status: 'APPROVED' }, data: { status: 'AI_GENERATED', approvedById: null, approvedAt: null } });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'practice.approval_revoked', targetTable: 'TrainingCourse', targetId: course.id, metadata: { version: course.draftVersion, components: changed.count } });
  return { ok: true, revoked: changed.count };
}

// ------------------------------------------------------------------ Supervisor Training Creation: review workflow
/**
 * A Supervisor with 'training.create' hands their prepared draft to an Admin. Reuses the exact
 * same readiness check as sending to Training (`sendBlocker`) — nothing may be submitted that
 * would not also be sendable — so there is no separate, divergent "ready" definition to maintain.
 * Idempotent: submitting again while already SUBMITTED changes nothing and still reports ok.
 */
async function submitForApproval(actor, course) {
  const isDraftEditable = !course.publishedVersion || (course.draftVersion || 1) > course.publishedVersion; // same rule as routes/aiPractice.js's editable()
  if (!isDraftEditable) return { ok: false, error: 'This version is already in Training.' };
  if (course.reviewStatus === 'SUBMITTED') return { ok: true, alreadySubmitted: true };
  const blocker = await sendBlocker(course);
  if (blocker) return { ok: false, error: blocker };
  const moved = await prisma.trainingCourse.updateMany({
    where: { id: course.id, reviewStatus: course.reviewStatus },
    data: { reviewStatus: 'SUBMITTED', reviewNote: null, submittedAt: new Date(), submittedById: actor.id },
  });
  if (!moved.count) return { ok: true, alreadySubmitted: true }; // lost a race with another submit — already covered
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'training.submitted_for_approval', targetTable: 'TrainingCourse', targetId: course.id, metadata: { version: course.draftVersion || 1 } });
  return { ok: true, alreadySubmitted: false };
}

/** Admin sends a submitted draft back with a required note. The Supervisor keeps working the same draft — nothing is discarded. */
async function requestChanges(actor, course, note) {
  const text = String(note || '').trim().slice(0, 1000);
  if (!text) return { ok: false, error: 'Explain what needs to change before sending this back.' };
  if (course.reviewStatus !== 'SUBMITTED') return { ok: false, error: 'This is not currently awaiting approval.' };
  const moved = await prisma.trainingCourse.updateMany({ where: { id: course.id, reviewStatus: 'SUBMITTED' }, data: { reviewStatus: 'CHANGES_REQUESTED', reviewNote: text } });
  if (!moved.count) return { ok: false, error: 'This is not currently awaiting approval.' };
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'training.changes_requested', targetTable: 'TrainingCourse', targetId: course.id, metadata: { note: text } });
  if (course.submittedById) {
    await createNotification({ profileId: course.submittedById, type: 'training.changes_requested', title: 'Changes requested', body: `An admin requested changes to "${course.title}": ${text}`, link: `/ai-practice/${course.id}?step=review` });
  }
  return { ok: true };
}

/** A light, read-only submission/review timeline for the detail page — built from the audit log, not a second history table. */
async function reviewHistory(courseId) {
  const rows = await prisma.auditLog.findMany({
    where: { targetTable: 'TrainingCourse', targetId: courseId, action: { in: ['training.submitted_for_approval', 'training.changes_requested', 'training.sent_to_training', 'training.version_published'] } },
    include: { actor: { select: { fullName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({ action: r.action, actorName: r.actor ? r.actor.fullName : 'Someone', at: r.createdAt, note: (() => { try { return JSON.parse(r.metadataJson || '{}').note || null; } catch { return null; } })() }));
}

// ------------------------------------------------------------------ Send to Training
/** What sending checks. Returns null when the package may be sent. */
async function sendBlocker(course) {
  const analysis = await prisma.trainingAnalysis.findUnique({ where: { courseId: course.id }, select: { status: true, sourceHash: true } });
  if (course.origin === 'AI_PRACTICE' && (!analysis || analysis.status !== 'APPROVED')) return 'Review the AI analysis before sending this to Training.';
  if (analysis && analysis.status !== 'APPROVED') return 'Approve the AI analysis before sending this to Training.';
  // Material can be added after the analysis was approved (POST .../sources has no analysis-status
  // restriction) without that re-opening the analysis/practice approval — so without this check, the
  // published package could silently stop matching the material it claims to be built from. Lazily
  // required: trainingAnalysis.js requires this module at load time, so a top-level require here
  // would be circular.
  if (analysis && analysis.sourceHash) {
    const { computeSourceHash } = require('./trainingAnalysis');
    const modules = await prisma.trainingModule.findMany({ where: { courseId: course.id }, select: { id: true, title: true, contentType: true, storagePath: true, externalUrl: true, description: true, addedInVersion: true, removedInVersion: true } });
    if (analysis.sourceHash !== computeSourceHash(modulesFor(modules, course.draftVersion || 1))) return 'The material changed since this was analyzed. Re-run the analysis before sending this to Training.';
  }
  const components = await packageComponents(course);
  if (course.origin === 'AI_PRACTICE' && !components.length) return 'Create and approve practice before sending this to Training.';
  if (components.some((a) => a.status !== 'APPROVED')) return 'Approve the practice before sending it — only approved practice can go to Training.';
  return null;
}

/**
 * Sends the approved package to Training. Idempotent: a double click (or two tabs) finds the version already
 * sent and changes nothing, so it can never create a duplicate Training entry.
 * `fields` may carry title/description/mandatory/passingScore/durationMinutes/roleKey chosen on the send screen.
 */
async function sendToTraining(actor, course, fields = {}) {
  if ((course.publishedVersion || 0) >= (course.draftVersion || 1) && course.status === 'PUBLISHED') return { ok: true, alreadySent: true, version: course.publishedVersion };
  const blocker = await sendBlocker(course);
  if (blocker) return { ok: false, error: blocker };

  const version = course.draftVersion || 1;
  const now = new Date();
  const components = await packageComponents(course);
  const analysis = await prisma.trainingAnalysis.findUnique({ where: { courseId: course.id } });
  const modules = modulesFor(await prisma.trainingModule.findMany({ where: { courseId: course.id }, select: { id: true, title: true, contentType: true, required: true, addedInVersion: true, removedInVersion: true } }), version).map(({ addedInVersion: _a, removedInVersion: _r, ...m }) => m);
  // Publishing always supersedes any pending Supervisor-submission review state, whether this
  // course went through that workflow or not — sentById/sentAt above already record the approving
  // Admin and when, satisfying "Approve & Send to Training records the approving Admin and timestamp".
  const data = { status: 'PUBLISHED', archivedAt: null, publishedVersion: version, sentAt: now, sentById: actor.id, reviewStatus: 'NONE', reviewNote: null };
  for (const key of ['title', 'description', 'mandatory', 'onboardingForNewHires', 'passingScore', 'durationMinutes', 'roleKey']) if (fields[key] !== undefined) data[key] = fields[key];
  const claimed = await prisma.$transaction(async (tx) => {
    // The guard makes the transition atomic: only one request can move publishedVersion forward.
    const moved = await tx.trainingCourse.updateMany({ where: { id: course.id, publishedVersion: course.publishedVersion || 0 }, data });
    if (!moved.count) return false;
    await tx.trainingVersion.updateMany({ where: { courseId: course.id, status: 'PUBLISHED', version: { not: version } }, data: { status: 'SUPERSEDED' } });
    const snapshotJson = JSON.stringify({
      title: data.title || course.title, passingScore: data.passingScore ?? course.passingScore, mandatory: data.mandatory ?? course.mandatory,
      assessmentIds: components.map((a) => a.id), assessments: components.map((a) => ({ id: a.id, type: a.type, title: a.title, level: a.level, passingScore: a.passingScore })),
      modules, skills: safe(analysis && analysis.extractedSkillsJson, []), analysisApprovedAt: analysis && analysis.approvedAt, analysisApprovedById: analysis && analysis.approvedById,
    });
    await tx.trainingVersion.upsert({
      where: { courseId_version: { courseId: course.id, version } },
      update: { status: 'PUBLISHED', publishedById: actor.id, publishedAt: now, snapshotJson },
      create: { courseId: course.id, version, status: 'PUBLISHED', publishedById: actor.id, publishedAt: now, snapshotJson, createdById: actor.id },
    });
    return true;
  });
  if (!claimed) return { ok: true, alreadySent: true, version };
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: version > 1 ? 'training.version_published' : 'training.sent_to_training', targetTable: 'TrainingCourse', targetId: course.id, metadata: { version, components: components.length } });
  return { ok: true, alreadySent: false, version };
}

// ------------------------------------------------------------------ new version
/** Starts version N+1 as an editable copy of the published practice. Assigned/completed training is untouched. */
async function createNewVersion(actor, course) {
  if (!course.publishedVersion) return { ok: false, error: 'Nothing has been sent to Training yet, so this can still be edited directly.' };
  if ((course.draftVersion || 1) > course.publishedVersion) return { ok: true, existing: true, version: course.draftVersion };
  const next = course.publishedVersion + 1;
  const source = await prisma.assessment.findMany({ where: { courseId: course.id, version: course.publishedVersion, archivedAt: null, status: 'APPROVED' }, include: { questions: { orderBy: { displayOrder: 'asc' } } } });
  const clonable = source.filter((a) => !isTargetedRetake(a));
  const claimed = await prisma.$transaction(async (tx) => {
    const moved = await tx.trainingCourse.updateMany({ where: { id: course.id, draftVersion: course.draftVersion || 1, publishedVersion: course.publishedVersion }, data: { draftVersion: next } });
    if (!moved.count) return false;
    for (const a of clonable) {
      await tx.assessment.create({
        data: {
          organizationId: a.organizationId, courseId: a.courseId, createdVia: a.createdVia, type: a.type, title: a.title, instructions: a.instructions, level: a.level, passingScore: a.passingScore,
          configJson: a.configJson, status: 'AI_GENERATED', createdById: actor.id, modelVersion: a.modelVersion, promptVersion: a.promptVersion, version: next, sourceAssessmentId: a.id,
          questions: { create: a.questions.map((q) => ({ type: q.type, prompt: q.prompt, optionsJson: q.optionsJson, correctAnswerJson: q.correctAnswerJson, explanation: q.explanation, skillIdsJson: q.skillIdsJson, sourceRefJson: q.sourceRefJson, displayOrder: q.displayOrder })) },
        },
      });
    }
    await tx.trainingVersion.upsert({ where: { courseId_version: { courseId: course.id, version: next } }, update: {}, create: { courseId: course.id, version: next, status: 'DRAFT', createdById: actor.id, note: `Copied from version ${course.publishedVersion}` } });
    return true;
  });
  if (!claimed) return { ok: true, existing: true, version: next };
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'practice.new_version_created', targetTable: 'TrainingCourse', targetId: course.id, metadata: { version: next, from: course.publishedVersion } });
  return { ok: true, existing: false, version: next };
}

/** Throws away an unpublished draft version and returns to the published one. */
async function discardDraftVersion(actor, course) {
  if ((course.draftVersion || 1) <= (course.publishedVersion || 0)) return { ok: false, error: 'There is no newer draft to discard.' };
  const draft = course.draftVersion;
  await prisma.$transaction(async (tx) => {
    await tx.assessment.updateMany({ where: { courseId: course.id, version: draft }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
    await tx.trainingModule.deleteMany({ where: { courseId: course.id, addedInVersion: draft } }); // material added only in the discarded draft
    await tx.trainingModule.updateMany({ where: { courseId: course.id, removedInVersion: draft }, data: { removedInVersion: null } });
    await tx.trainingVersion.deleteMany({ where: { courseId: course.id, version: draft, status: 'DRAFT' } });
    await tx.trainingCourse.update({ where: { id: course.id }, data: { draftVersion: course.publishedVersion } });
  });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'practice.draft_version_discarded', targetTable: 'TrainingCourse', targetId: course.id, metadata: { version: draft } });
  return { ok: true };
}

async function versionHistory(courseId) {
  return prisma.trainingVersion.findMany({ where: { courseId }, orderBy: { version: 'desc' } });
}

// ------------------------------------------------------------------ safe deletion
/** A source can be deleted only if nothing that matters depends on it; otherwise it is archived instead. */
async function deletionPolicy(course) {
  const reasons = [];
  if ((course.publishedVersion || 0) > 0 || course.status === 'PUBLISHED') reasons.push('it was sent to Training');
  const [assignments, attempts, evidence] = await Promise.all([
    prisma.trainingAssignment.count({ where: { courseId: course.id } }),
    prisma.trainingAttempt.count({ where: { assessment: { courseId: course.id } } }),
    prisma.skillEvidence.count({ where: { assessmentId: { in: (await prisma.assessment.findMany({ where: { courseId: course.id }, select: { id: true } })).map((a) => a.id) } } }),
  ]);
  if (assignments) reasons.push('it has been assigned to employees');
  if (attempts) reasons.push('employees have attempted its practice');
  if (evidence) reasons.push('skill evidence was recorded from it');
  return { canDelete: reasons.length === 0, reasons };
}

/** Hides a source from AI Practice without touching Training. */
async function archiveSource(actor, course) {
  await prisma.trainingCourse.update({ where: { id: course.id }, data: { workspaceArchivedAt: new Date() } });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'ai_practice.source_archived', targetTable: 'TrainingCourse', targetId: course.id });
}

async function restoreSource(actor, course) {
  await prisma.trainingCourse.update({ where: { id: course.id }, data: { workspaceArchivedAt: null } });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'ai_practice.source_restored', targetTable: 'TrainingCourse', targetId: course.id });
}

module.exports = {
  liveVersion, modulesFor, learnerVersion, draftWhere, publishedWhere, packageComponents, lockReason, isTargetedRetake,
  approvePackage, revokeApproval, sendBlocker, sendToTraining, createNewVersion, discardDraftVersion, versionHistory,
  deletionPolicy, archiveSource, restoreSource, getSetting,
  submitForApproval, requestChanges, reviewHistory,
};
