'use strict';

// Supervisor team intelligence ("who needs my attention?"), the team skill map, and bulk assignment for
// Supervisors (their own team) and Admins (the whole organization). The set of people a caller may act on
// is computed here from the database each time — never taken from the request.
const router = require('express').Router();
const { prisma } = require('../lib/prisma');
const { requireRole } = require('../lib/authMiddleware');
const { supervisedProfileIds } = require('../lib/authz');
const { excludeOtherAdminsTestProfiles } = require('../lib/loginAsScope');
const { teamIntelligence, peopleBelow, WEAK } = require('../lib/teamIntel');
const { assignableCoursesWhere } = require('../lib/trainingPermissions');
const { bulkAssign, BulkError, KIND_LABEL } = require('../lib/bulkAssign');
const { coversSkill } = require('../lib/development');
const { roleLabel } = require('../lib/roles');

const manage = requireRole('ADMIN', 'SUPERVISOR');

/** The employees this actor may assign to: a Supervisor's assigned team, or everyone for an Admin. */
async function allowedIdsFor(actor) {
  if (actor.role === 'SUPERVISOR') return supervisedProfileIds(actor.id);
  const rows = await prisma.profile.findMany({ where: { organizationId: actor.organizationId, status: { in: ['ACTIVE', 'INVITED'] }, ...excludeOtherAdminsTestProfiles(actor) }, select: { id: true } });
  return rows.map((r) => r.id);
}

router.get('/team-skills', requireRole('SUPERVISOR'), async (req, res) => {
  const actor = req.profile;
  const ids = await supervisedProfileIds(actor.id);
  const [intel, recommendations] = await Promise.all([
    teamIntelligence(actor.organizationId, ids),
    ids.length ? prisma.developmentRecommendation.findMany({ where: { organizationId: actor.organizationId, profileId: { in: ids }, status: 'OPEN' }, orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }], take: 30, include: { profile: { select: { id: true, fullName: true } } } }) : [],
  ]);
  res.set('Cache-Control', 'private, no-store');
  res.render('team-intel', { title: 'Team Intelligence', intel, recommendations, WEAK, roleLabel, error: typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : null });
});

router.get('/bulk-assign', manage, async (req, res) => {
  const actor = req.profile;
  const allowed = await allowedIdsFor(actor);
  const skillId = typeof req.query.skillId === 'string' ? req.query.skillId : '';
  const skill = skillId ? await prisma.skill.findFirst({ where: { id: skillId, organizationId: actor.organizationId } }) : null;
  const max = Math.min(100, Math.max(1, Number(req.query.max) || WEAK));

  const [people, courses] = await Promise.all([
    skill ? peopleBelow(allowed, skill.id, { max }) : prisma.profile.findMany({ where: { id: { in: allowed }, organizationId: actor.organizationId, status: { in: ['ACTIVE', 'INVITED'] } }, select: { id: true, fullName: true, role: true }, orderBy: { fullName: 'asc' } }),
    prisma.trainingCourse.findMany({ where: assignableCoursesWhere(actor), orderBy: { title: 'asc' }, include: { assessments: { where: { status: 'APPROVED', archivedAt: null }, include: { questions: { select: { skillIdsJson: true } } } } } }),
  ]);
  const candidates = skill ? people.map((p) => ({ id: p.profile.id, fullName: p.profile.fullName, role: p.profile.role, score: Math.round(p.currentScore) })) : people.map((p) => ({ id: p.id, fullName: p.fullName, role: p.role, score: null }));
  const preselected = typeof req.query.personId === 'string' && allowed.includes(req.query.personId) ? [req.query.personId] : (skill ? candidates.map((c) => c.id) : []);
  const practices = courses.flatMap((c) => c.assessments.filter((a) => JSON.parse(a.configJson || '{}').targetedRetake !== true && (!skill || coversSkill(a, skill.name))).map((a) => ({ id: a.id, courseId: c.id, title: a.title, type: a.type })));
  res.render('bulk-assign', { title: 'Assign', skill, max, candidates, preselected, courses: courses.map((c) => ({ id: c.id, title: c.title, passingScore: c.passingScore })), practices, KIND_LABEL, roleLabel, error: typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : null, done: /^\d+:\d+$/.test(String(req.query.done || '')) ? String(req.query.done).split(':').map(Number) : null, isAdmin: actor.role === 'ADMIN' });
});

router.post('/bulk-assign', manage, async (req, res) => {
  const actor = req.profile;
  const back = (extra) => `/bulk-assign?${new URLSearchParams(extra).toString()}`;
  try {
    const result = await bulkAssign(actor, await allowedIdsFor(actor), {
      kind: req.body.kind, employeeIds: req.body.employeeIds, courseId: req.body.courseId, assessmentId: req.body.assessmentId,
      skillId: req.body.skillId, dueDate: req.body.dueDate, dueTime: req.body.dueTime, minimumScore: req.body.minimumScore, requiredAttempts: req.body.requiredAttempts, note: req.body.note,
    });
    return res.redirect(back({ done: `${result.created}:${result.skipped}` }));
  } catch (err) {
    if (err instanceof BulkError) {
      if (err.status === 403) return res.status(403).render('forbidden');
      if (err.status === 404) return res.status(404).render('not-found', { layout: false });
      return res.redirect(back({ error: err.message }));
    }
    throw err;
  }
});

module.exports = router;
