'use strict';

// Skill DNA: each employee's live competency profile, built only from Skill Evidence. The same page
// serves the employee (their own, under My Training), their Supervisor and Admin (coaching view).
// Every route authorizes through loadEmployeeFor(): self, an Admin, or the employee's own Supervisor.
const router = require('express').Router();
const { prisma } = require('../lib/prisma');
const { requireSession } = require('../lib/authMiddleware');
const { loadEmployeeFor, credentialAccess } = require('../lib/employeeAccess');
const { employeeTabs } = require('../lib/employeeTabs');
const { roleLabel } = require('../lib/roles');
const { getSkillRows, classifySkills, categorySummary, loadConfig } = require('../lib/skillIntel');
const { nextActions } = require('../lib/development');
const { getMyTrainingList } = require('../lib/training');
const { recomputeSkillScore } = require('../lib/scoring');
const engine = require('../lib/skillEngine');
const { logAudit } = require('../lib/audit');
const { createNotification } = require('../lib/notifications');

const notFound = (res) => res.status(404).render('not-found', { layout: false });
const isManager = (actor, ctx) => !ctx.isSelf && (actor.role === 'ADMIN' || actor.role === 'SUPERVISOR');

async function frameFor(req, ctx) {
  const access = await credentialAccess(req.profile, ctx.employee, { impersonating: Boolean(req.impersonation) });
  return { tabs: employeeTabs(req.profile, ctx, { credentials: access.view || access.manage }), employee: ctx.employee, isSelf: ctx.isSelf, roleLabel };
}

function overallOf(rows) {
  const assessed = rows.filter((r) => r.assessed);
  return {
    score: assessed.length ? Math.round(assessed.reduce((n, r) => n + r.score, 0) / assessed.length) : null,
    assessed: assessed.length,
    total: rows.length,
    high: assessed.filter((r) => r.confidenceLevel === 'HIGH').length,
  };
}

async function coachingData(employee) {
  const [training, attempts, callEvidence, notes] = await Promise.all([
    getMyTrainingList(employee.id),
    prisma.trainingAttempt.findMany({ where: { profileId: employee.id, assessmentId: { not: null } }, include: { assessment: { select: { id: true, title: true, type: true, level: true, passingScore: true, course: { select: { title: true } } } } }, orderBy: { createdAt: 'desc' }, take: 40 }),
    prisma.skillEvidence.findMany({ where: { employeeSkill: { profileId: employee.id }, assessmentType: 'CALL_ANALYSIS' }, include: { employeeSkill: { include: { skill: true } } }, orderBy: { createdAt: 'desc' }, take: 40 }),
    prisma.coachingNote.findMany({ where: { profileId: employee.id }, include: { author: { select: { fullName: true } } }, orderBy: { createdAt: 'desc' }, take: 30 }),
  ]);
  return { training, attempts, callEvidence, notes };
}

async function renderDna(req, res, ctx, mode) {
  const actor = req.profile;
  const employee = ctx.employee;
  const [rows, dev, config] = await Promise.all([getSkillRows(employee), nextActions(employee), loadConfig(employee.organizationId)]);
  const sections = classifySkills(rows);
  const manager = isManager(actor, ctx);
  const view = {
    title: mode === 'learner' ? 'Skill DNA' : `${employee.fullName} — Skill DNA`,
    mode,
    rows,
    sections,
    categories: categorySummary(rows),
    overall: overallOf(rows),
    dev: { items: dev.items.slice(0, 5), next: dev.next },
    bands: config.bands,
    manager,
    isSelf: ctx.isSelf,
    employee,
    coaching: manager ? await coachingData(employee) : null,
    saved: req.query.saved === '1',
    error: typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : null,
    TYPE_LABEL: engine.TYPE_LABEL,
  };
  if (mode === 'employee') Object.assign(view, await frameFor(req, ctx));
  res.set('Cache-Control', 'private, no-store');
  res.render('skill-dna', view);
}

// My own Skill DNA (any role that has skills: agents, flight experts, supervisors, admins).
router.get('/skill-graph', requireSession, async (req, res) => {
  const ctx = await loadEmployeeFor(req.profile, req.profile.id);
  if (!ctx) return notFound(res);
  await renderDna(req, res, ctx, 'learner');
});

router.get('/employees/:id/skills', requireSession, async (req, res) => {
  const ctx = await loadEmployeeFor(req.profile, req.params.id);
  if (!ctx) return notFound(res);
  if (ctx.isSelf) return res.redirect('/skill-graph');
  await renderDna(req, res, ctx, 'employee');
});

// One skill: score, status, confidence, the timeline and — most importantly — WHY the score is what it is.
router.get('/employees/:id/skills/:skillRowId', requireSession, async (req, res) => {
  const ctx = await loadEmployeeFor(req.profile, req.params.id);
  if (!ctx) return notFound(res);
  const employee = ctx.employee;
  const row = (await getSkillRows(employee, { ensure: false })).find((r) => r.id === req.params.skillRowId);
  if (!row) return notFound(res); // a skill row that belongs to somebody else looks like a missing one
  const [evidence, history, config] = await Promise.all([
    prisma.skillEvidence.findMany({ where: { employeeSkillId: row.id, scoreImpact: { not: null } }, orderBy: { createdAt: 'desc' }, take: 500 }),
    prisma.skillScoreHistory.findMany({ where: { employeeSkillId: row.id }, orderBy: { recordedAt: 'asc' }, take: 500 }),
    loadConfig(employee.organizationId),
  ]);
  const computed = engine.computeSkill(evidence, { ...engine.DEFAULT_ENGINE, ...config.scoring });
  const view = { title: `${row.skill.name} — evidence`, row, computed, history, bands: config.bands, manager: isManager(req.profile, ctx), mode: ctx.isSelf ? 'learner' : 'employee', employee, isSelf: ctx.isSelf, TYPE_LABEL: engine.TYPE_LABEL, engineVersion: engine.ENGINE_VERSION, halfLifeDays: config.scoring.halfLifeDays, saved: req.query.saved === '1', error: null };
  if (!ctx.isSelf) Object.assign(view, await frameFor(req, ctx));
  res.set('Cache-Control', 'private, no-store');
  res.render('skill-detail', view);
});

// Supervisor coaching note: feedback the employee is notified about.
router.post('/employees/:id/coaching-notes', requireSession, async (req, res) => {
  const actor = req.profile;
  const ctx = await loadEmployeeFor(actor, req.params.id);
  if (!ctx) return notFound(res);
  if (!isManager(actor, ctx)) return res.status(403).render('forbidden');
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (body.length < 3) return res.redirect(`/employees/${ctx.employee.id}/skills?error=${encodeURIComponent('Write the coaching note first.')}`);
  const note = await prisma.coachingNote.create({ data: { organizationId: actor.organizationId, profileId: ctx.employee.id, authorId: actor.id, body } });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'coaching.note_added', targetTable: 'CoachingNote', targetId: note.id, metadata: { employeeId: ctx.employee.id } });
  await createNotification({ profileId: ctx.employee.id, type: 'coaching.feedback', title: 'New feedback from your supervisor', body: 'A coaching note was added to your profile.', link: '/skill-graph' }).catch(() => undefined);
  res.redirect(`/employees/${ctx.employee.id}/skills?saved=1`);
});

// Supervisor assessment: a person's own observation of a skill, stored as evidence (with a 0-100 score)
// like any other — it is weighed by the engine, it never overwrites the score directly.
router.post('/employees/:id/skills/:skillRowId/assessment', requireSession, async (req, res) => {
  const actor = req.profile;
  const ctx = await loadEmployeeFor(actor, req.params.id);
  if (!ctx) return notFound(res);
  if (!isManager(actor, ctx)) return res.status(403).render('forbidden');
  const row = await prisma.employeeSkill.findFirst({ where: { id: req.params.skillRowId, profileId: ctx.employee.id }, include: { skill: true } });
  if (!row) return notFound(res);
  const score = Number(req.body.score);
  const notes = String(req.body.notes || '').trim().slice(0, 1000);
  const back = `/employees/${ctx.employee.id}/skills`;
  if (!Number.isFinite(score) || score < 0 || score > 100) return res.redirect(`${back}?error=${encodeURIComponent('Enter a score between 0 and 100.')}`);
  if (notes.length < 10) return res.redirect(`${back}?error=${encodeURIComponent('Say what you observed (at least a sentence).')}`);
  const before = { score: row.currentScore, evidenceCount: row.evidenceCount };
  await prisma.skillEvidence.create({ data: { employeeSkillId: row.id, sourceType: 'MANUAL_ADJUSTMENT', assessmentType: 'SUPERVISOR_ASSESSMENT', scoreImpact: Math.round(score), notes: `Supervisor assessment by ${actor.fullName}: ${notes}`, recordedById: actor.id, difficulty: 3, weight: engine.kindWeight({ assessmentType: 'SUPERVISOR_ASSESSMENT' }) } });
  const result = await recomputeSkillScore(row.id, { note: `Supervisor assessment recorded by ${actor.fullName}.` });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'skill.supervisor_assessment', targetTable: 'EmployeeSkill', targetId: row.id, metadata: { employeeId: ctx.employee.id, skill: row.skill.name, assessed: Math.round(score), previousScore: Math.round(before.score), newScore: result ? result.currentScore : null } });
  res.redirect(`${back}?saved=1`);
});

module.exports = router;
