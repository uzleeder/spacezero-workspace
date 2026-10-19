'use strict';

// Admin: development automation (onboarding paths, assignment rules, the recommendation queue),
// certifications, and the skills & categories taxonomy. Admin only, organization-scoped, every
// change audited. Automation can only ever RECOMMEND, or assign published, approved training an Admin
// attached to a rule or path step — it never changes scores, permissions or roles.
const express = require('express');
const router = express.Router();
const { prisma } = require('../../lib/prisma');
const { requireAdmin } = require('../../lib/authMiddleware');
const { requireSystemConfigAccess } = require('../../lib/supervisorCapabilities');
// Development automation, certification definitions and the skills taxonomy are all "Admin
// Configuration" (Task 3, Training/Skills) — organization-wide rules, not day-to-day management.
const advanced = [requireAdmin, requireSystemConfigAccess];
const { logAudit } = require('../../lib/audit');
const { roleLabel } = require('../../lib/roles');
const { runAutomation } = require('../../lib/automation');
const { normalizeRequirements, evaluateOrganization, CONF_RANK } = require('../../lib/certifications');
const { ensureTaxonomy } = require('../../lib/skillTaxonomy');
const { recomputeOrganization } = require('../../lib/scoring');

const ROLES = ['TRAVEL_AGENT', 'FLIGHT_EXPERT', 'SUPERVISOR'];
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const int = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };
const role = (v) => (ROLES.includes(v) ? v : null);
const skillRole = (v) => (v === 'ADMIN' ? v : role(v));
const asList = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(String);
const notFound = (res) => res.status(404).render('not-found', { layout: false });
const back = (res, path, params = { saved: '1' }) => res.redirect(`${path}${Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : ''}`);
router.use((req, res, next) => { res.locals.saved = req.query.saved === '1'; next(); });
const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

const publishedCourse = (organizationId, id) => prisma.trainingCourse.findFirst({ where: { id: String(id || ''), organizationId, status: 'PUBLISHED', archivedAt: null }, select: { id: true, title: true } });

// ------------------------------------------------------------------ development: paths, rules, queue
async function renderDevelopment(req, res, extras = {}) {
  const organizationId = req.profile.organizationId;
  const [recommendations, paths, rules, courses, skills, bands] = await Promise.all([
    prisma.developmentRecommendation.findMany({ where: { organizationId, status: 'OPEN' }, orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }], take: 100, include: { profile: { select: { id: true, fullName: true, role: true } } } }),
    prisma.developmentPath.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' }, include: { steps: { orderBy: { dayOffset: 'asc' } } } }),
    prisma.assignmentRule.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } }),
    prisma.trainingCourse.findMany({ where: { organizationId, status: 'PUBLISHED', archivedAt: null }, orderBy: { title: 'asc' }, select: { id: true, title: true } }),
    prisma.skill.findMany({ where: { organizationId, isActive: true }, orderBy: [{ category: 'asc' }, { name: 'asc' }], select: { id: true, name: true, roleKey: true } }),
    prisma.tenureBand.findMany({ where: { organizationId }, orderBy: { displayOrder: 'asc' } }),
  ]);
  const courseTitle = new Map(courses.map((c) => [c.id, c.title]));
  const skillName = new Map(skills.map((s) => [s.id, s.name]));
  const ruleRows = rules.map((r) => ({ ...r, condition: parse(r.conditionJson, {}), courseTitle: r.courseId ? courseTitle.get(r.courseId) || '(unavailable)' : null }));
  res.set('Cache-Control', 'private, no-store');
  res.render('admin/development', { title: 'Development automation', recommendations, paths: paths.map((p) => ({ ...p, steps: p.steps.map((s) => ({ ...s, courseTitle: s.courseId ? courseTitle.get(s.courseId) || '(unavailable)' : null })) })), rules: ruleRows, courses, skills, skillName, bands, ROLES, roleLabel, ran: typeof req.query.ran === 'string' ? req.query.ran.slice(0, 300) : null, error: typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : null, values: {}, saved: req.query.saved === '1', ...extras });
}
router.get('/development', advanced, renderDevelopment);
router.renderDevelopment = renderDevelopment;

router.post('/development/run', advanced, async (req, res) => {
  const s = await runAutomation(req.profile.organizationId, { actorId: req.profile.id });
  const bits = [`${s.retentionScheduled} follow-ups scheduled`, `${s.retention.checked} checked`, `${s.paths.recommended + s.rules.recommended} recommended`, `${s.paths.assigned + s.rules.assigned} assigned`, `${s.certifications.issued} certificates issued`];
  back(res, '/admin/development', { ran: bits.join(' · ') });
});

router.post('/development/paths', advanced, async (req, res) => {
  const name = text(req.body.name, 80);
  if (name.length < 2) return back(res, '/admin/development', { error: 'Enter a name for the path.' });
  const path = await prisma.developmentPath.create({ data: { organizationId: req.profile.organizationId, name, roleKey: role(req.body.roleKey), description: text(req.body.description, 300) || null, createdById: req.profile.id } });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'development.path_created', targetTable: 'DevelopmentPath', targetId: path.id, metadata: { name, role: path.roleKey } });
  back(res, '/admin/development');
});

async function ownPath(req) { return prisma.developmentPath.findFirst({ where: { id: req.params.id, organizationId: req.profile.organizationId } }); }

router.post('/development/paths/:id/toggle', advanced, async (req, res) => {
  const path = await ownPath(req); if (!path) return notFound(res);
  await prisma.developmentPath.update({ where: { id: path.id }, data: { isActive: !path.isActive } });
  await logAudit({ organizationId: path.organizationId, actorId: req.profile.id, action: 'development.path_toggled', targetTable: 'DevelopmentPath', targetId: path.id, metadata: { isActive: !path.isActive } });
  back(res, '/admin/development');
});

router.post('/development/paths/:id/delete', advanced, async (req, res) => {
  const path = await ownPath(req); if (!path) return notFound(res);
  await prisma.developmentPath.delete({ where: { id: path.id } }); // recommendations already created stay as history
  await logAudit({ organizationId: path.organizationId, actorId: req.profile.id, action: 'development.path_deleted', targetTable: 'DevelopmentPath', targetId: path.id, metadata: { name: path.name } });
  back(res, '/admin/development');
});

router.post('/development/paths/:id/steps', advanced, async (req, res) => {
  const path = await ownPath(req); if (!path) return notFound(res);
  const dayOffset = int(req.body.dayOffset, 0, 730);
  const title = text(req.body.title, 120);
  if (dayOffset === null || title.length < 2) return back(res, '/admin/development', { error: 'A step needs a day (0–730) and a title.' });
  let courseId = null;
  if (req.body.courseId) { const c = await publishedCourse(path.organizationId, req.body.courseId); if (!c) return back(res, '/admin/development', { error: 'Choose a published training.' }); courseId = c.id; }
  const autoAssign = req.body.autoAssign === '1' && Boolean(courseId);
  const step = await prisma.developmentPathStep.create({ data: { pathId: path.id, dayOffset, title, courseId, autoAssign } });
  await logAudit({ organizationId: path.organizationId, actorId: req.profile.id, action: 'development.step_added', targetTable: 'DevelopmentPathStep', targetId: step.id, metadata: { path: path.name, dayOffset, courseId, autoAssign } });
  back(res, '/admin/development');
});

router.post('/development/steps/:id/delete', advanced, async (req, res) => {
  const step = await prisma.developmentPathStep.findFirst({ where: { id: req.params.id, path: { organizationId: req.profile.organizationId } } });
  if (!step) return notFound(res);
  await prisma.developmentPathStep.delete({ where: { id: step.id } });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'development.step_deleted', targetTable: 'DevelopmentPathStep', targetId: step.id });
  back(res, '/admin/development');
});

router.post('/development/rules', advanced, async (req, res) => {
  const organizationId = req.profile.organizationId;
  const name = text(req.body.name, 80);
  const condition = {};
  const minAgeDays = req.body.minAgeDays === '' || req.body.minAgeDays === undefined ? null : int(req.body.minAgeDays, 0, 3650);
  if (minAgeDays !== null) condition.minAgeDays = minAgeDays;
  if (req.body.skillId) {
    const skill = await prisma.skill.findFirst({ where: { id: String(req.body.skillId), organizationId } });
    const below = int(req.body.below, 1, 100);
    if (!skill || below === null) return back(res, '/admin/development', { error: 'A skill condition needs a skill and a score (1–100).' });
    Object.assign(condition, { skillId: skill.id, below, minConfidence: CONF_RANK[req.body.minConfidence] ? req.body.minConfidence : 'MEDIUM' });
  }
  if (req.body.retakeOutstanding === '1') condition.retakeOutstanding = true;
  if (name.length < 2 || !Object.keys(condition).length) return back(res, '/admin/development', { error: 'A rule needs a name and at least one condition.' });
  let courseId = null;
  if (req.body.courseId) { const c = await publishedCourse(organizationId, req.body.courseId); if (!c) return back(res, '/admin/development', { error: 'Choose a published training.' }); courseId = c.id; }
  const action = req.body.action === 'ASSIGN' && courseId ? 'ASSIGN' : 'RECOMMEND'; // recommending is the default; assigning needs an approved training
  const rule = await prisma.assignmentRule.create({ data: { organizationId, name, roleKey: role(req.body.roleKey), conditionJson: JSON.stringify(condition), action, courseId, createdById: req.profile.id } });
  await logAudit({ organizationId, actorId: req.profile.id, action: 'development.rule_created', targetTable: 'AssignmentRule', targetId: rule.id, metadata: { name, action, condition, courseId } });
  back(res, '/admin/development');
});

router.post('/development/rules/:id/toggle', advanced, async (req, res) => {
  const rule = await prisma.assignmentRule.findFirst({ where: { id: req.params.id, organizationId: req.profile.organizationId } });
  if (!rule) return notFound(res);
  await prisma.assignmentRule.update({ where: { id: rule.id }, data: { isActive: !rule.isActive } });
  await logAudit({ organizationId: rule.organizationId, actorId: req.profile.id, action: 'development.rule_toggled', targetTable: 'AssignmentRule', targetId: rule.id, metadata: { isActive: !rule.isActive } });
  back(res, '/admin/development');
});

router.post('/development/rules/:id/delete', advanced, async (req, res) => {
  const rule = await prisma.assignmentRule.findFirst({ where: { id: req.params.id, organizationId: req.profile.organizationId } });
  if (!rule) return notFound(res);
  await prisma.assignmentRule.delete({ where: { id: rule.id } });
  await logAudit({ organizationId: rule.organizationId, actorId: req.profile.id, action: 'development.rule_deleted', targetTable: 'AssignmentRule', targetId: rule.id, metadata: { name: rule.name } });
  back(res, '/admin/development');
});

// ------------------------------------------------------------------ certifications
router.get('/certifications', advanced, async (req, res) => {
  const organizationId = req.profile.organizationId;
  const [definitions, courses, skills, recent] = await Promise.all([
    prisma.certificationDefinition.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' }, include: { _count: { select: { earned: true } } } }),
    prisma.trainingCourse.findMany({ where: { organizationId, status: 'PUBLISHED', archivedAt: null }, orderBy: { title: 'asc' }, select: { id: true, title: true } }),
    prisma.skill.findMany({ where: { organizationId, isActive: true }, orderBy: [{ category: 'asc' }, { name: 'asc' }], select: { id: true, name: true, roleKey: true } }),
    prisma.earnedCertification.findMany({ where: { definition: { organizationId } }, orderBy: { issuedAt: 'desc' }, take: 40, include: { definition: { select: { name: true, kind: true } }, profile: { select: { id: true, fullName: true } } } }),
  ]);
  const courseTitle = new Map(courses.map((c) => [c.id, c.title]));
  const skillName = new Map(skills.map((s) => [s.id, s.name]));
  const defs = definitions.map((d) => {
    const req2 = normalizeRequirements(parse(d.requirementsJson, {}));
    const parts = [...req2.courseIds.map((id) => `Complete ${courseTitle.get(id) || 'training'}`), ...req2.assessmentIds.map(() => 'Pass a required assessment'), ...req2.skills.map((s) => `${skillName.get(s.skillId) || 'Skill'} ≥ ${s.min}% (${s.minConfidence.toLowerCase()} confidence)`)];
    if (req2.noOutstandingRetakes) parts.push('No outstanding retakes');
    return { ...d, parts };
  });
  res.set('Cache-Control', 'private, no-store');
  res.render('admin/certifications', { title: 'Certifications', defs, courses, skills, recent, ROLES, roleLabel, ran: typeof req.query.ran === 'string' ? req.query.ran.slice(0, 200) : null, error: typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : null });
});

router.post('/certifications', advanced, async (req, res) => {
  const organizationId = req.profile.organizationId;
  const name = text(req.body.name, 80);
  if (name.length < 2) return back(res, '/admin/certifications', { error: 'Enter a name.' });
  const courseIds = [];
  for (const id of asList(req.body.courseIds)) { const c = await publishedCourse(organizationId, id); if (c) courseIds.push(c.id); }
  const skillRows = [];
  for (const i of [1, 2, 3]) {
    if (!req.body[`skillId_${i}`]) continue;
    const skill = await prisma.skill.findFirst({ where: { id: String(req.body[`skillId_${i}`]), organizationId } });
    const min = int(req.body[`min_${i}`], 1, 100);
    if (skill && min !== null) skillRows.push({ skillId: skill.id, min, minConfidence: req.body[`conf_${i}`] });
  }
  const requirements = normalizeRequirements({ courseIds, skills: skillRows, noOutstandingRetakes: req.body.noOutstandingRetakes === '1' });
  if (!requirements.courseIds.length && !requirements.skills.length) return back(res, '/admin/certifications', { error: 'Require at least one completed training or one skill level — a certification must reflect demonstrated competency.' });
  const validityDays = req.body.validityDays ? int(req.body.validityDays, 1, 3650) : null;
  const def = await prisma.certificationDefinition.create({ data: { organizationId, name, description: text(req.body.description, 300) || null, kind: req.body.kind === 'ACHIEVEMENT' ? 'ACHIEVEMENT' : 'CERTIFICATION', roleKey: role(req.body.roleKey), requirementsJson: JSON.stringify(requirements), validityDays, renewalNote: text(req.body.renewalNote, 200) || null, createdById: req.profile.id } });
  await logAudit({ organizationId, actorId: req.profile.id, action: 'certification.definition_created', targetTable: 'CertificationDefinition', targetId: def.id, metadata: { name, requirements, validityDays } });
  back(res, '/admin/certifications');
});

router.post('/certifications/evaluate', advanced, async (req, res) => {
  const r = await evaluateOrganization(req.profile.organizationId);
  back(res, '/admin/certifications', { ran: `${r.issued} issued · ${r.expired} expired` });
});

router.post('/certifications/:id/toggle', advanced, async (req, res) => {
  const def = await prisma.certificationDefinition.findFirst({ where: { id: req.params.id, organizationId: req.profile.organizationId } });
  if (!def) return notFound(res);
  await prisma.certificationDefinition.update({ where: { id: def.id }, data: { isActive: !def.isActive } });
  await logAudit({ organizationId: def.organizationId, actorId: req.profile.id, action: 'certification.definition_toggled', targetTable: 'CertificationDefinition', targetId: def.id, metadata: { isActive: !def.isActive } });
  back(res, '/admin/certifications');
});

router.post('/certifications/earned/:id/revoke', advanced, async (req, res) => {
  const earned = await prisma.earnedCertification.findFirst({ where: { id: req.params.id, definition: { organizationId: req.profile.organizationId } } });
  if (!earned) return notFound(res);
  await prisma.earnedCertification.update({ where: { id: earned.id }, data: { status: 'REVOKED' } });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'certification.revoked', targetTable: 'EarnedCertification', targetId: earned.id, metadata: { employeeId: earned.profileId } });
  back(res, '/admin/certifications');
});

// ------------------------------------------------------------------ skills & categories
async function renderSkills(req, res, extras = {}) {
  const organizationId = req.profile.organizationId;
  const [skills, courses] = await Promise.all([
    prisma.skill.findMany({ where: { organizationId }, orderBy: [{ isActive: 'desc' }, { category: 'asc' }, { displayOrder: 'asc' }, { name: 'asc' }], include: { _count: { select: { employeeSkills: true } } } }),
    prisma.trainingCourse.findMany({ where: { organizationId, status: 'PUBLISHED', archivedAt: null, analysis: { status: 'APPROVED' } }, select: { id: true, title: true }, orderBy: { title: 'asc' } }),
  ]);
  const categories = [...new Set(skills.map((s) => s.category).filter(Boolean))].sort();
  res.set('Cache-Control', 'private, no-store');
  res.render('admin/skills', { title: 'Skill Catalog', skills, categories, courses, ROLES: ['ADMIN', ...ROLES], roleLabel, notice: typeof req.query.notice === 'string' ? req.query.notice.slice(0, 200) : null, error: typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : null, values: {}, ...extras });
}
router.get('/skills', advanced, (req, res) => renderSkills(req, res));
router.renderSkills = renderSkills;

router.post('/skills', advanced, async (req, res) => {
  const organizationId = req.profile.organizationId;
  const name = text(req.body.name, 80);
  const category = (req.body.category === '__new' ? text(req.body.newCategory, 60) : text(req.body.category, 60)) || null;
  if (name.length < 2) return back(res, '/admin/skills', { error: 'Enter a skill name.' });
  const roleKey = skillRole(req.body.roleKey);
  const duplicate = await prisma.skill.findFirst({ where: { organizationId, roleKey, name: { equals: name } } });
  if (duplicate) return back(res, '/admin/skills', { error: 'A skill with that name already exists for this role.' });
  const skill = await prisma.skill.create({ data: { organizationId, name, category, roleKey, description: text(req.body.description, 300) || null } });
  await logAudit({ organizationId, actorId: req.profile.id, action: 'skill.created', targetTable: 'Skill', targetId: skill.id, metadata: { name, category, role: roleKey } });
  back(res, '/admin/skills', { notice: `Added ${name}.` });
});

router.post('/skills/taxonomy', advanced, async (req, res) => {
  const r = await ensureTaxonomy(req.profile.organizationId);
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'skill.taxonomy_applied', targetTable: 'Organization', targetId: req.profile.organizationId, metadata: r });
  back(res, '/admin/skills', { notice: `Added ${r.created} recommended skills, regrouped ${r.regrouped}.` });
});

router.post('/skills/recalculate', advanced, async (req, res) => {
  const r = await recomputeOrganization(req.profile.organizationId);
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'skill.recalculated', targetTable: 'Organization', targetId: req.profile.organizationId, metadata: { rows: r } });
  back(res, '/admin/skills', { notice: 'Skill scores recalculated from evidence. History was preserved.' });
});

/** Micro-practice: a 2–5 minute targeted practice for ONE skill, generated from an approved training. Starts as AI_GENERATED and needs approval. */
router.post('/skills/micro-practice', advanced, async (req, res) => {
  const organizationId = req.profile.organizationId;
  const skill = await prisma.skill.findFirst({ where: { id: String(req.body.skillId || ''), organizationId, isActive: true } });
  if (!skill) return notFound(res);
  const course = await prisma.trainingCourse.findFirst({ where: { id: String(req.body.courseId || ''), organizationId, status: 'PUBLISHED', archivedAt: null }, include: { analysis: true } });
  if (!course || !course.analysis || course.analysis.status !== 'APPROVED') return back(res, '/admin/skills', { error: 'Choose a published training with an approved analysis.' });
  try {
    const { generateQuestionAssessment } = require('../../lib/practiceEngine');
    const created = await generateQuestionAssessment({ course, analysis: course.analysis, actor: req.profile, type: 'QUIZ', level: 3, questionCount: 3, focusSkills: [skill.name], status: 'AI_GENERATED' });
    await prisma.assessment.update({ where: { id: created.id }, data: { title: `Micro-practice: ${skill.name}`, configJson: JSON.stringify({ micro: true, focusSkills: [skill.name], estimatedMinutes: 3 }) } });
    await logAudit({ organizationId, actorId: req.profile.id, action: 'practice.micro_generated', targetTable: 'Assessment', targetId: created.id, metadata: { skill: skill.name, courseId: course.id } });
    return back(res, '/admin/skills', { notice: `Micro-practice for ${skill.name} generated. Review and approve it before it can be assigned.` });
  } catch {
    return back(res, '/admin/skills', { error: 'The AI service could not generate the practice right now. Nothing was created — try again later.' });
  }
});

router.post('/skills/:id', advanced, async (req, res) => {
  const skill = await prisma.skill.findFirst({ where: { id: req.params.id, organizationId: req.profile.organizationId } });
  if (!skill) return notFound(res);
  const name = text(req.body.name, 80);
  if (name.length < 2) return back(res, '/admin/skills', { error: 'Enter a skill name.' });
  const category = (req.body.category === '__new' ? text(req.body.newCategory, 60) : text(req.body.category, 60)) || null;
  const data = { name, category, roleKey: skillRole(req.body.roleKey), description: text(req.body.description, 300) || null, isActive: req.body.isActive === '1' };
  await prisma.skill.update({ where: { id: skill.id }, data });
  await logAudit({ organizationId: skill.organizationId, actorId: req.profile.id, action: 'skill.updated', targetTable: 'Skill', targetId: skill.id, metadata: { before: { name: skill.name, category: skill.category, role: skill.roleKey, isActive: skill.isActive }, after: { name, category, role: data.roleKey, isActive: data.isActive } } });
  back(res, '/admin/skills', { notice: 'Skill updated. Archived skills keep their history.' });
});

module.exports = router;
