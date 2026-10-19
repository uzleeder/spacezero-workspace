'use strict';

// Brings work created BEFORE the upload-first workflow into it, without inventing anything:
//   * earlier raw "AI Practice" uploads (PracticeMaterial) become saved sources you can analyze now;
//   * unpublished courses that were AI Practice material are marked as such;
//   * training that was already sent gets its version-1 record;
//   * analyses that stopped moving are put back in the queue (their finished steps are kept).
// Idempotent and cheap (a few indexed queries), so the AI Practice home simply runs it when it opens.
const { prisma } = require('./prisma');
const { logAudit } = require('./audit');
const { STUCK_MS } = require('./aiPracticeState');

const MODULE_TYPE = { VIDEO: 'VIDEO', PDF: 'PDF', SLIDES: 'PPT', DOC: 'DOC' };

async function probeSeconds(storagePath) {
  try { return Math.ceil(await require('./mediaProbe').probeMedia(storagePath)); } catch { return null; }
}

async function importMaterial(organizationId, material) {
  // Claim first so two page loads at the same moment cannot import the same upload twice.
  const claim = await prisma.practiceMaterial.updateMany({ where: { id: material.id, migratedCourseId: null, migratedBatchId: null }, data: { migratedCourseId: 'importing' } });
  if (!claim.count) return null;
  try {
    if (material.materialType === 'CALL') {
      if (!material.storagePath) { await prisma.practiceMaterial.update({ where: { id: material.id }, data: { migratedCourseId: null } }); return null; }
      const batch = await prisma.callBatch.create({
        data: { organizationId, uploadedById: material.profileId, mode: 'BEST_PRACTICE', title: material.title, createdAt: material.createdAt, recordings: { create: { storagePath: material.storagePath, mimeType: material.mimeType || 'audio/mpeg', originalFilename: material.title, durationSeconds: await probeSeconds(material.storagePath) } } },
      });
      await prisma.practiceMaterial.update({ where: { id: material.id }, data: { migratedCourseId: null, migratedBatchId: batch.id } });
      return { kind: 'call', id: batch.id };
    }
    const isNote = material.materialType === 'NOTE';
    if (!isNote && !material.storagePath) { await prisma.practiceMaterial.update({ where: { id: material.id }, data: { migratedCourseId: null } }); return null; }
    const seconds = material.materialType === 'VIDEO' && material.storagePath ? await probeSeconds(material.storagePath) : null;
    const course = await prisma.trainingCourse.create({
      data: {
        organizationId, title: material.title, description: material.description, createdById: material.profileId, createdAt: material.createdAt, origin: 'AI_PRACTICE', status: 'DRAFT',
        modules: { create: { title: material.title, description: isNote ? material.noteContent : material.description, contentType: isNote ? 'NOTE' : MODULE_TYPE[material.materialType] || 'DOC', storagePath: isNote ? null : material.storagePath, ...(seconds ? { sourceRefJson: JSON.stringify({ durationSeconds: seconds }) } : {}) } },
      },
    });
    await prisma.practiceMaterial.update({ where: { id: material.id }, data: { migratedCourseId: course.id } });
    return { kind: 'material', id: course.id };
  } catch (err) {
    await prisma.practiceMaterial.update({ where: { id: material.id }, data: { migratedCourseId: null } }).catch(() => undefined);
    throw err;
  }
}

/** Runs the whole backfill for the actor's organization. Returns what changed. */
async function ensureWorkspace(actor, { now = new Date() } = {}) {
  const organizationId = actor.organizationId;
  const summary = { imported: 0, marked: 0, versions: 0, resumed: 0 };

  // 1. Unpublished courses were AI Practice work under the old hub already.
  const marked = await prisma.trainingCourse.updateMany({ where: { organizationId, status: 'DRAFT', origin: 'MANUAL' }, data: { origin: 'AI_PRACTICE' } });
  summary.marked = marked.count;

  // 2. Earlier raw uploads -> saved sources.
  const pending = await prisma.practiceMaterial.findMany({ where: { organizationId, archivedAt: null, migratedCourseId: null, migratedBatchId: null }, orderBy: { createdAt: 'asc' } });
  for (const material of pending) { if (await importMaterial(organizationId, material)) summary.imported += 1; }

  // 3. Training that was already sent gets its version-1 record (facts only: who approved the analysis, which practice existed).
  const unrecorded = await prisma.trainingCourse.findMany({ where: { organizationId, publishedVersion: { gte: 1 }, versions: { none: {} } }, include: { analysis: true, assessments: { where: { archivedAt: null, status: 'APPROVED' }, select: { id: true, type: true, title: true, level: true, passingScore: true } } } });
  for (const course of unrecorded) {
    await prisma.trainingVersion.create({ data: { courseId: course.id, version: course.publishedVersion, status: 'PUBLISHED', publishedAt: course.sentAt || course.updatedAt, approvedAt: course.analysis && course.analysis.approvedAt, approvedById: course.analysis && course.analysis.approvedById, note: 'Recorded from what was already in Training.', snapshotJson: JSON.stringify({ title: course.title, passingScore: course.passingScore, assessmentIds: course.assessments.map((a) => a.id), assessments: course.assessments }) } }).catch((err) => { if (!err || err.code !== 'P2002') throw err; });
    summary.versions += 1;
  }

  // 4. Analyses that stopped moving continue where they stopped.
  const cutoff = new Date(now.getTime() - STUCK_MS);
  const stuck = await prisma.trainingAnalysis.findMany({ where: { course: { organizationId }, status: { in: ['QUEUED', 'EXTRACTING', 'MAPPING', 'VALIDATING'] }, updatedAt: { lt: cutoff } }, select: { id: true, courseId: true } });
  for (const row of stuck) {
    const moved = await prisma.trainingAnalysis.updateMany({ where: { id: row.id, status: { in: ['EXTRACTING', 'MAPPING', 'VALIDATING'] }, updatedAt: { lt: cutoff } }, data: { status: 'QUEUED', queuedAt: now, errorMessage: 'Continued after it stopped moving.' } });
    summary.resumed += moved.count;
  }

  if (summary.imported || summary.versions || summary.resumed) {
    await logAudit({ organizationId, actorId: actor.id, action: 'ai_practice.workspace_backfilled', targetTable: 'Organization', targetId: organizationId, metadata: summary });
  }
  return summary;
}

module.exports = { ensureWorkspace, importMaterial };
