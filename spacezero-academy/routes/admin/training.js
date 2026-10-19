'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { mkdir, writeFile } = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { prisma } = require('../../lib/prisma');
const { requireRole } = require('../../lib/authMiddleware');
const { CourseSchema, ModuleInputSchema, MIN_PASSING_SCORE } = require('../../lib/validation');
const { readAudience, describeAudience, parseAudience, checkPassingScore } = require('../../lib/courseAudience');
const { getSetting } = require('../../lib/orgSettings');
const { excludeOtherAdminsTestProfiles } = require('../../lib/loginAsScope');
const { logAudit } = require('../../lib/audit');
const { roleLabel } = require('../../lib/roles');
const { POLICIES, POLICY_LABEL, mayAssign } = require('../../lib/trainingPermissions');
const versions = require('../../lib/courseVersions');
const courseDeletion = require('../../lib/courseDeletion');
const categories = require('../../lib/trainingCategories');
const analysisLib = require('../../lib/trainingAnalysis');
const { z } = require('zod');

const canManage = requireRole('ADMIN', 'SUPERVISOR'); // viewing the approved catalog
const adminOnly = requireRole('ADMIN'); // creating, reviewing, approving and publishing training is AI Practice work: Admin only

// Course thumbnails live under /static/uploads/course-thumbnails, but
// lib/privateUploads.js intercepts that path and re-checks session/
// organization before serving — they are not actually open static files.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const ALLOWED_THUMBNAIL_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const THUMBNAIL_DIR = path.join(require('../../lib/uploadRoot').UPLOAD_ROOT, 'course-thumbnails');

function canEditCourse(actor, course) {
  return course.organizationId === actor.organizationId && actor.role === 'ADMIN';
}

/** Where this training came from (spec: Training <-> AI Practice traceability). */
async function traceFor(course) {
  if (course.origin !== 'AI_PRACTICE') return null;
  const [versionRows, call, analysis] = await Promise.all([
    versions.versionHistory(course.id),
    prisma.callBatch.findFirst({ where: { generatedCourseId: course.id }, select: { id: true } }),
    prisma.trainingAnalysis.findUnique({ where: { courseId: course.id }, select: { approvedAt: true, approvedById: true } }),
  ]);
  const published = versionRows.find((v) => v.status === 'PUBLISHED') || null;
  const approver = analysis && analysis.approvedById ? await prisma.profile.findUnique({ where: { id: analysis.approvedById }, select: { fullName: true } }) : null;
  return { versions: versionRows, published, callId: call ? call.id : null, analysisApprovedAt: analysis ? analysis.approvedAt : null, approver: approver ? approver.fullName : null };
}

// Extra, permission-related data every render of the training detail page needs.
async function detailExtras(actor, course) {
  const grants = await prisma.trainingAssignGrant.findMany({ where: { courseId: course.id }, select: { supervisorId: true } });
  const supervisors = actor.role === 'ADMIN'
    ? await prisma.profile.findMany({ where: { organizationId: actor.organizationId, role: 'SUPERVISOR', status: 'ACTIVE', testOwnerAdminId: null }, orderBy: { fullName: 'asc' }, select: { id: true, fullName: true } })
    : [];
  return {
    POLICIES,
    POLICY_LABEL,
    supervisors,
    grantedIds: grants.map((g) => g.supervisorId),
    canAssign: mayAssign(actor, { ...course, assignGrants: grants }),
    sendError: null,
    trace: await traceFor(course),
    audienceSummary: await describeAudience(actor, course),
    audience: parseAudience(course),
    dueDateValue: course.defaultDueDate ? course.defaultDueDate.toISOString().slice(0, 10) : '',
    teams: await prisma.team.findMany({ where: { organizationId: actor.organizationId, archivedAt: null }, orderBy: { name: 'asc' } }),
    people: actor.role === 'ADMIN' ? await prisma.profile.findMany({ where: { organizationId: actor.organizationId, status: { not: 'ARCHIVED' }, ...excludeOtherAdminsTestProfiles(actor) }, orderBy: { fullName: 'asc' }, select: { id: true, fullName: true, role: true } }) : [],
    minPassingScore: await getSetting(actor.organizationId, 'training.minPassingScore'),
  };
}
router.get('/training', canManage, async (req, res) => {
  const actor = req.profile;
  const showArchived = req.query.view === 'archived';
  // The Training area is the APPROVED catalog: only courses that were sent to Training. Drafts and
  // in-progress AI work live in AI Practice. Supervisors can browse the catalog (view-only unless
  // the Admin allowed them to assign a course); archived courses stay limited to their own.
  const where = showArchived
    ? { organizationId: actor.organizationId, archivedAt: { not: null }, ...(actor.role === 'SUPERVISOR' ? { createdById: actor.id } : {}) }
    : { organizationId: actor.organizationId, status: 'PUBLISHED', archivedAt: null };
  const courses = await prisma.trainingCourse.findMany({
    where,
    include: { modules: true, assignGrants: { select: { supervisorId: true } }, _count: { select: { assignments: true } } },
    orderBy: { createdAt: 'desc' },
  });
  // Hierarchy: Training Catalog -> Category -> Approved / Archived -> list. The category is chosen here; the status (Approved / Archived) is a separate switch.
  const counts = categories.countByCategory(courses);
  let category = categories.readFilter(req.query.category);
  if (!category || (category === 'UNCATEGORIZED' && !counts.UNCATEGORIZED)) category = categories.KEYS.find((k) => counts[k] > 0) || (counts.UNCATEGORIZED ? 'UNCATEGORIZED' : categories.KEYS[0]);
  const shown = courses.filter((c) => categories.matches(c, category));
  // Delete: an Admin for any training; a Supervisor only for a training they created whose assignments are all theirs.
  const deletable = req.impersonation ? new Set() : await courseDeletion.deletableCourseIds(actor, shown);
  const rows = shown.map((c) => ({ ...c, canAssign: !showArchived && mayAssign(actor, c), canDelete: deletable.has(c.id) }));
  res.render('admin/training/index', { title: 'Training', courses: rows, showArchived, POLICY_LABEL, CATEGORIES: categories.CATEGORIES, categoryLabel: categories.categoryLabel, counts, category, canSetCategory: actor.role === 'ADMIN', deletedNotice: req.query.deleted === '1' });
});

// Admin: choose (or change) the Training Category of any training - the way a training that predates categories gets one.
router.post('/training/:id/category', adminOnly, async (req, res) => {
  const actor = req.profile;
  const course = await prisma.trainingCourse.findFirst({ where: { id: req.params.id, organizationId: actor.organizationId } });
  if (!course) return res.status(404).render('not-found', { layout: false });
  const trainingCategory = categories.readCategory(req.body.trainingCategory);
  const view = req.body.view === 'archived' ? '&view=archived' : '';
  if (!trainingCategory) return res.redirect(`/admin/training?category=${categories.readFilter(req.body.from) || ''}${view}`);
  if (trainingCategory !== course.trainingCategory) {
    await prisma.trainingCourse.update({ where: { id: course.id }, data: { trainingCategory } });
    await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'training.category_set', targetTable: 'TrainingCourse', targetId: course.id, metadata: { from: course.trainingCategory || null, to: trainingCategory } });
  }
  res.redirect(req.body.back === 'detail' ? `/admin/training/${course.id}` : `/admin/training?category=${trainingCategory}${view}`);
});

async function newFormData(actor, extra = {}) {
  const [teams, people, minPassingScore] = await Promise.all([
    prisma.team.findMany({ where: { organizationId: actor.organizationId, archivedAt: null }, orderBy: { name: 'asc' } }),
    prisma.profile.findMany({ where: { organizationId: actor.organizationId, status: { not: 'ARCHIVED' }, ...excludeOtherAdminsTestProfiles(actor) }, orderBy: { fullName: 'asc' }, select: { id: true, fullName: true, role: true } }),
    getSetting(actor.organizationId, 'training.minPassingScore'),
  ]);
  return { title: 'New training course', error: null, teams, people, minPassingScore, values: {}, ...extra };
}

// Creating material now happens in AI Practice (upload first, analyze later). The old form URL leads there.
router.get('/training/new', requireRole('ADMIN'), (req, res) => res.redirect('/ai-practice/new'));

router.post('/training/new', requireRole('ADMIN'), async (req, res) => {
  const actor = req.profile;
  const parsed = CourseSchema.safeParse({
    title: req.body.title,
    description: req.body.description || undefined,
    roleKey: req.body.roleKey || '',
    mandatory: req.body.mandatory === '1',
    passingScore: req.body.passingScore || MIN_PASSING_SCORE,
  });
  const fail = async (message) => res.status(200).render('admin/training/new', await newFormData(actor, { error: message, values: req.body }));
  if (!parsed.success) return fail(parsed.error.issues.find((i) => i.path[0] === 'passingScore')?.message || 'Enter a course title.');
  const scoreError = await checkPassingScore(actor.organizationId, parsed.data.passingScore);
  if (scoreError) return fail(scoreError);
  const audience = await readAudience(actor, req.body);
  if (audience.error) return fail(audience.error);

  let modulesRaw;
  try {
    modulesRaw = JSON.parse(req.body.modulesJson || '[]');
  } catch {
    return fail('Could not read the module list.');
  }
  const moduleParse = z.array(ModuleInputSchema).min(1).safeParse(modulesRaw);
  if (!moduleParse.success) {
    return fail('Add at least one complete module.');
  }

  const course = await prisma.trainingCourse.create({
    data: {
      organizationId: actor.organizationId,
      origin: 'AI_PRACTICE',
      title: parsed.data.title,
      description: parsed.data.description,
      roleKey: audience.data.roleKey,
      audienceJson: audience.data.audienceJson,
      defaultDueDate: audience.data.dueDate,
      mandatory: parsed.data.mandatory,
      passingScore: parsed.data.passingScore,
      createdById: actor.id,
      modules: {
        create: moduleParse.data.map((m, i) => ({
          title: m.title,
          description: m.description,
          contentType: m.contentType,
          externalUrl: m.externalUrl,
          durationMinutes: m.durationMinutes,
          displayOrder: i,
        })),
      },
    },
  });

  await logAudit({
    organizationId: actor.organizationId,
    actorId: actor.id,
    action: 'training.course_created',
    targetTable: 'TrainingCourse',
    targetId: course.id,
    metadata: { title: course.title },
  });

  res.redirect(`/ai-practice/${course.id}`);
});

router.get('/training/:id', canManage, async (req, res) => {
  const actor = req.profile;
  const course = await prisma.trainingCourse.findFirst({
    where: { id: req.params.id, organizationId: actor.organizationId },
    include: {
      modules: { orderBy: { displayOrder: 'asc' } },
      assignments: { include: { _count: { select: { recipients: true } } } },
      createdBy: true,
      analysis: true,
      assessments: { select: { id: true, status: true, archivedAt: true } },
    },
  });
  if (!course) return res.status(404).render('not-found', { layout: false });
  // Work that has not been sent to Training yet is managed in AI Practice.
  if (course.origin === 'AI_PRACTICE' && !course.publishedVersion && course.status === 'DRAFT') return res.redirect(`/ai-practice/${course.id}`);
  course.modules = versions.modulesFor(course.modules, versions.liveVersion(course)); // Training shows the version employees get
  res.render('admin/training/detail', {
    title: course.title,
    course,
    roleLabel,
    canEdit: canEditCourse(actor, course),
    canDelete: !req.impersonation && await courseDeletion.mayDeleteCourse(actor, course),
    editError: null,
    ...(await detailExtras(actor, course)),
  });
});

router.post('/training/:id/edit', adminOnly, upload.single('thumbnail'), async (req, res) => {
  const actor = req.profile;
  const existing = await prisma.trainingCourse.findFirst({
    where: { id: req.params.id, organizationId: actor.organizationId },
    include: {
      modules: { orderBy: { displayOrder: 'asc' } },
      assignments: { include: { _count: { select: { recipients: true } } } },
      createdBy: true,
      analysis: true,
    },
  });
  if (!existing) return res.status(404).render('not-found', { layout: false });
  if (!canEditCourse(actor, existing)) return res.status(403).render('forbidden');

  const rerender = async (editError) =>
    res.render('admin/training/detail', { title: existing.title, course: existing, roleLabel, canEdit: true, canDelete: actor.role === 'ADMIN', editError, ...(await detailExtras(actor, existing)) });

  const parsed = CourseSchema.safeParse({
    title: req.body.title,
    description: req.body.description || undefined,
    roleKey: req.body.roleKey || existing.roleKey || '',
    mandatory: req.body.mandatory === undefined ? existing.mandatory : [].concat(req.body.mandatory).includes('1'),
    passingScore: req.body.passingScore || existing.passingScore,
  });
  if (!parsed.success) return rerender(parsed.error.issues.find((i) => i.path[0] === 'passingScore')?.message || 'Enter a course title.');
  const scoreError = await checkPassingScore(actor.organizationId, parsed.data.passingScore);
  if (scoreError) return rerender(scoreError);
  const audience = req.body.audienceForm === '1' ? await readAudience(actor, req.body) : null;
  if (audience && audience.error) return rerender(audience.error);

  let thumbnailUrl = existing.thumbnailUrl;
  if (req.file) {
    const uploadError = require('../../lib/storage').validateUpload('IMAGE', req.file);
    if (uploadError) return rerender(uploadError);
    if (!ALLOWED_THUMBNAIL_TYPES.includes(req.file.mimetype)) {
      return rerender('Only PNG, JPEG, or WEBP images are allowed for the thumbnail.');
    }
    await mkdir(THUMBNAIL_DIR, { recursive: true });
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[req.file.mimetype];
    const filename = `${existing.id}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    await writeFile(path.join(THUMBNAIL_DIR, filename), req.file.buffer);
    thumbnailUrl = `/static/uploads/course-thumbnails/${filename}`;
  }

  await prisma.trainingCourse.update({
    where: { id: existing.id },
    data: {
      title: parsed.data.title,
      description: parsed.data.description,
      ...(audience ? { roleKey: audience.data.roleKey, audienceJson: audience.data.audienceJson, defaultDueDate: audience.data.dueDate } : { roleKey: parsed.data.roleKey || null }),
      mandatory: parsed.data.mandatory,
      passingScore: parsed.data.passingScore,
      ...(req.body.onboardingForm === '1' ? { onboardingForNewHires: req.body.onboarding === '1' } : {}),
      durationMinutes: req.body.durationMinutes ? Number(req.body.durationMinutes) : null,
      thumbnailUrl,
    },
  });

  await logAudit({
    organizationId: actor.organizationId,
    actorId: actor.id,
    action: 'training.course_edited',
    targetTable: 'TrainingCourse',
    targetId: existing.id,
  });

  res.redirect(`/admin/training/${existing.id}`);
});

async function setCourseStatus(req, res, status) {
  const actor = req.profile;
  const course = await prisma.trainingCourse.findUnique({ where: { id: req.params.id } });
  if (course && course.organizationId === actor.organizationId && actor.role === 'ADMIN') {
    if (status === 'PUBLISHED') {
      const sent = await versions.sendToTraining(actor, course);
      if (!sent.ok) return res.status(409).json({ ok: false, error: sent.error });
      return res.json({ ok: true });
    }
    await prisma.trainingCourse.update({ where: { id: course.id }, data: { status, archivedAt: status === 'ARCHIVED' ? new Date() : null } });
    await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: `training.course_${status.toLowerCase()}`, targetTable: 'TrainingCourse', targetId: course.id });
  }
  res.json({ ok: true });
}

// "Send to Training" now lives in AI Practice (it sends the approved package). This URL keeps working and applies the same rules.
router.post('/training/:id/send-to-training', adminOnly, async (req, res) => {
  const actor = req.profile;
  const course = await prisma.trainingCourse.findFirst({ where: { id: req.params.id, organizationId: actor.organizationId } });
  if (!course) return res.status(404).render('not-found', { layout: false });
  if (!canEditCourse(actor, course)) return res.status(403).render('forbidden');
  const sent = await versions.sendToTraining(actor, course);
  if (!sent.ok) return res.status(409).render('error', { layout: false, message: sent.error });
  res.redirect('/admin/training');
});

// Admin decides which supervisors may ASSIGN this training. Viewing is separate from assigning.
router.post('/training/:id/assign-permissions', requireRole('ADMIN'), async (req, res) => {
  const actor = req.profile;
  const course = await prisma.trainingCourse.findFirst({ where: { id: req.params.id, organizationId: actor.organizationId }, include: { assignGrants: true } });
  if (!course) return res.status(404).render('not-found', { layout: false });
  const policy = String(req.body.assignPolicy || '');
  if (!POLICIES.includes(policy)) return res.status(400).send('Invalid policy.');

  const requested = [].concat(req.body.supervisorIds || []).map(String);
  const valid = policy === 'SELECTED_SUPERVISORS'
    ? await prisma.profile.findMany({ where: { id: { in: requested }, organizationId: actor.organizationId, role: 'SUPERVISOR', status: 'ACTIVE' }, select: { id: true } })
    : [];
  const wanted = new Set(valid.map((v) => v.id));
  const current = new Set(course.assignGrants.map((g) => g.supervisorId));

  await prisma.$transaction([
    prisma.trainingCourse.update({ where: { id: course.id }, data: { assignPolicy: policy } }),
    prisma.trainingAssignGrant.deleteMany({ where: { courseId: course.id, supervisorId: { notIn: [...wanted] } } }),
    ...[...wanted].filter((id) => !current.has(id)).map((supervisorId) => prisma.trainingAssignGrant.create({ data: { courseId: course.id, supervisorId, grantedById: actor.id } })),
  ]);

  if (policy !== course.assignPolicy) await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'training.assign_policy_changed', targetTable: 'TrainingCourse', targetId: course.id, metadata: { from: course.assignPolicy, to: policy } });
  for (const id of wanted) if (!current.has(id)) await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'training.permission_granted', targetTable: 'TrainingCourse', targetId: course.id, metadata: { supervisorId: id } });
  for (const id of current) if (!wanted.has(id)) await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'training.permission_revoked', targetTable: 'TrainingCourse', targetId: course.id, metadata: { supervisorId: id } });
  res.redirect('/admin/training/' + course.id);
});

router.post('/training/:id/publish', adminOnly, (req, res) => setCourseStatus(req, res, 'PUBLISHED'));
router.post('/training/:id/draft', adminOnly, (req, res) => setCourseStatus(req, res, 'DRAFT'));
router.post('/training/:id/archive', adminOnly, (req, res) => setCourseStatus(req, res, 'ARCHIVED'));

// Admin only, any training: even one that was sent to Training, assigned, attempted or has skill evidence.
// A confirmation page first shows exactly what goes; archiving stays available as the gentler choice.
// A Supervisor may delete a training they created themselves while every assignment of it is theirs (see lib/courseDeletion.js).
router.get('/training/:id/delete', canManage, async (req, res) => {
  if (req.impersonation) return res.status(403).render('forbidden');
  const course = await prisma.trainingCourse.findFirst({ where: { id: req.params.id, organizationId: req.profile.organizationId } });
  if (!course) return res.status(404).render('not-found', { layout: false });
  if (!await courseDeletion.mayDeleteCourse(req.profile, course)) return res.status(403).render('forbidden');
  res.render('admin/training/delete', { title: 'Delete training', course, impact: await courseDeletion.deletionImpact(course) });
});

router.post('/training/:id/delete', canManage, async (req, res) => {
  const actor = req.profile;
  if (req.impersonation) return res.status(403).render('forbidden');
  const course = await prisma.trainingCourse.findFirst({ where: { id: req.params.id, organizationId: actor.organizationId } });
  if (!course) return res.status(404).render('not-found', { layout: false });
  if (!await courseDeletion.mayDeleteCourse(actor, course)) return res.status(403).render('forbidden');
  await courseDeletion.deleteCourse(actor, course);
  res.redirect('/admin/training?deleted=1');
});

// Analysis and practice are handled in AI Practice. These URLs keep working (same rules, idempotent) and lead there.
router.post('/training/:id/analyze', adminOnly, async (req, res) => {
  const actor = req.profile;
  const course = await prisma.trainingCourse.findFirst({ where: { id: req.params.id, organizationId: actor.organizationId } });
  if (!course) return res.status(404).render('not-found', { layout: false });
  if (!canEditCourse(actor, course)) return res.status(403).render('forbidden');
  const row = await analysisLib.enqueueAnalysis(course.id, { startedById: actor.id });
  if (!row.duplicate) await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'ai_practice.analysis_started', targetTable: 'TrainingCourse', targetId: course.id });
  res.redirect(`/ai-practice/${course.id}?step=analysis`);
});

router.get('/training/:id/analysis', adminOnly, async (req, res) => {
  const course = await prisma.trainingCourse.findFirst({ where: { id: req.params.id, organizationId: req.profile.organizationId }, include: { analysis: true } });
  if (!course) return res.status(404).render('not-found', { layout: false });
  res.redirect(course.analysis ? `/ai-practice/${course.id}?step=analysis` : `/ai-practice/${course.id}`);
});

router.post('/training/:id/analysis/approve', adminOnly, async (req, res) => {
  const actor = req.profile;
  const course = await prisma.trainingCourse.findFirst({ where: { id: req.params.id, organizationId: actor.organizationId }, include: { analysis: true } });
  if (!course || !course.analysis) return res.status(404).render('not-found', { layout: false });
  if (!canEditCourse(actor, course)) return res.status(403).render('forbidden');
  if (course.analysis.status !== 'READY_FOR_REVIEW') return res.status(400).render('error', { layout: false, message: 'This analysis is not ready to approve yet.' });
  const moved = await prisma.trainingAnalysis.updateMany({ where: { id: course.analysis.id, status: 'READY_FOR_REVIEW' }, data: { status: 'APPROVED', approvedById: actor.id, approvedAt: new Date() } });
  if (moved.count) await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'training.analysis_approved', targetTable: 'TrainingCourse', targetId: course.id });
  res.redirect(`/ai-practice/${course.id}?step=practice`);
});

router.post('/training/:id/analysis/regenerate', adminOnly, async (req, res) => {
  const actor = req.profile;
  const course = await prisma.trainingCourse.findFirst({ where: { id: req.params.id, organizationId: actor.organizationId } });
  if (!course) return res.status(404).render('not-found', { layout: false });
  if (!canEditCourse(actor, course)) return res.status(403).render('forbidden');
  const row = await analysisLib.enqueueAnalysis(course.id, { startedById: actor.id });
  if (!row.duplicate) await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'training.analysis_regenerated', targetTable: 'TrainingCourse', targetId: course.id });
  res.redirect(`/ai-practice/${course.id}?step=analysis`);
});

module.exports = router;
