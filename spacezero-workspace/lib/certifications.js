'use strict';

// Certifications and achievements represent DEMONSTRATED competency. Requirements are checked against
// real training results and skill evidence (score AND evidence confidence), so finishing a video can
// never earn one. Requirements are data an Admin edits; each issued certificate stores a snapshot of the
// evidence it was based on, an optional expiry and renewal note.
const { prisma } = require('./prisma');
const { logAudit } = require('./audit');
const { notifyOnce } = require('./notifications');

const CONF_RANK = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

/** Normalises requirements coming from a form or from storage. */
function normalizeRequirements(input) {
  const list = (v) => [...new Set((Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean))];
  return {
    courseIds: list(input.courseIds),
    assessmentIds: list(input.assessmentIds),
    skills: (Array.isArray(input.skills) ? input.skills : []).filter((s) => s && s.skillId && Number.isFinite(Number(s.min))).map((s) => ({ skillId: String(s.skillId), min: Math.max(0, Math.min(100, Math.round(Number(s.min)))), minConfidence: CONF_RANK[s.minConfidence] ? s.minConfidence : 'MEDIUM' })),
    noOutstandingRetakes: input.noOutstandingRetakes !== false && input.noOutstandingRetakes !== 'false' && input.noOutstandingRetakes !== '0',
  };
}

/** Checks one definition against one employee. Pure reads; returns each requirement with its outcome. */
async function evaluate(definition, profile) {
  const req = normalizeRequirements(parse(definition.requirementsJson, {}));
  const checks = [];

  if (req.courseIds.length) {
    const courses = await prisma.trainingCourse.findMany({ where: { id: { in: req.courseIds }, organizationId: profile.organizationId }, select: { id: true, title: true } });
    const recipients = await prisma.trainingAssignmentRecipient.findMany({ where: { profileId: profile.id, assignment: { courseId: { in: req.courseIds } } }, include: { attempts: { select: { status: true, attemptNumber: true } }, assignment: { select: { courseId: true } } } });
    for (const course of courses) {
      const done = recipients.filter((r) => r.assignment.courseId === course.id).some((r) => { const latest = [...r.attempts].sort((a, b) => b.attemptNumber - a.attemptNumber)[0]; return latest && latest.status === 'COMPLETED'; });
      checks.push({ type: 'course', label: `Complete "${course.title}"`, ok: done, detail: done ? 'Completed' : 'Not completed yet' });
    }
  }
  if (req.skills.length) {
    const rows = await prisma.employeeSkill.findMany({ where: { profileId: profile.id, skillId: { in: req.skills.map((s) => s.skillId) } }, include: { skill: true } });
    for (const need of req.skills) {
      const row = rows.find((r) => r.skillId === need.skillId);
      const skill = row ? row.skill : await prisma.skill.findUnique({ where: { id: need.skillId } });
      const score = row && row.evidenceCount > 0 ? Math.round(row.currentScore) : null;
      const conf = row && row.evidenceCount > 0 ? row.confidenceLevel : 'NONE';
      const ok = score !== null && score >= need.min && CONF_RANK[conf] >= CONF_RANK[need.minConfidence];
      checks.push({ type: 'skill', skillId: need.skillId, label: `${skill ? skill.name : 'Skill'} at ${need.min}% or more with ${need.minConfidence.toLowerCase()} evidence confidence`, ok, detail: score === null ? 'No evidence yet' : `${score}%, ${conf.toLowerCase()} confidence`, score, confidence: conf, evidenceCount: row ? row.evidenceCount : 0 });
    }
  }
  if (req.assessmentIds.length) {
    const assessments = await prisma.assessment.findMany({ where: { id: { in: req.assessmentIds }, organizationId: profile.organizationId }, select: { id: true, title: true, passingScore: true, type: true } });
    const attempts = await prisma.trainingAttempt.findMany({ where: { profileId: profile.id, assessmentId: { in: req.assessmentIds } }, orderBy: { attemptNumber: 'desc' }, select: { assessmentId: true, status: true, score: true } });
    for (const a of assessments) {
      const latest = attempts.find((x) => x.assessmentId === a.id);
      const ok = Boolean(latest && latest.status === 'COMPLETED' && (latest.score ?? 0) >= a.passingScore);
      checks.push({ type: 'assessment', label: `Pass "${a.title}"`, ok, detail: latest ? `Latest ${latest.score !== null ? Math.round(latest.score) + '%' : latest.status.toLowerCase()}` : 'Not attempted', score: latest ? latest.score : null });
    }
  }
  if (req.noOutstandingRetakes) {
    const recipients = await prisma.trainingAssignmentRecipient.findMany({ where: { profileId: profile.id }, include: { attempts: { select: { status: true, attemptNumber: true }, orderBy: { attemptNumber: 'desc' }, take: 1 } } });
    const outstanding = recipients.filter((r) => r.attempts[0] && ['RETAKE_REQUIRED', 'FAILED'].includes(r.attempts[0].status)).length;
    checks.push({ type: 'retakes', label: 'No mandatory retakes outstanding', ok: outstanding === 0, detail: outstanding ? `${outstanding} outstanding` : 'None outstanding' });
  }
  return { met: checks.length > 0 && checks.every((c) => c.ok), checks };
}

/** Issues the certificate when every requirement is met. Never issues twice while an ACTIVE one exists. */
async function issueIfEligible(definition, profile, { issuedById = null, now = new Date() } = {}) {
  if (!definition.isActive || (definition.roleKey && definition.roleKey !== profile.role) || profile.status !== 'ACTIVE') return null;
  const active = await prisma.earnedCertification.findFirst({ where: { definitionId: definition.id, profileId: profile.id, status: 'ACTIVE' } });
  if (active) return null;
  const result = await evaluate(definition, profile);
  if (!result.met) return null;
  const earned = await prisma.earnedCertification.create({
    data: {
      definitionId: definition.id, profileId: profile.id, issuedAt: now, issuedById,
      expiresAt: definition.validityDays ? new Date(now.getTime() + definition.validityDays * 86400000) : null,
      snapshotJson: JSON.stringify({ issuedFor: definition.name, engine: 'requirements-check', checks: result.checks, renewalNote: definition.renewalNote || null }),
    },
  });
  await logAudit({ organizationId: definition.organizationId, actorId: issuedById, action: 'certification.issued', targetTable: 'EarnedCertification', targetId: earned.id, metadata: { employeeId: profile.id, definition: definition.name } });
  await notifyOnce(profile.id, `cert:${earned.id}`, { type: 'certification.earned', title: `${definition.kind === 'ACHIEVEMENT' ? 'Achievement' : 'Certification'} earned`, body: `You earned "${definition.name}".`, link: '/dashboard' });
  return earned;
}

/** Evaluates every active definition for every active employee of the organization; also expires old ones. */
async function evaluateOrganization(organizationId, { now = new Date() } = {}) {
  const definitions = await prisma.certificationDefinition.findMany({ where: { organizationId, isActive: true } });
  let issued = 0; let expired = 0;
  const lapsed = await prisma.earnedCertification.findMany({ where: { status: 'ACTIVE', expiresAt: { lt: now }, definition: { organizationId } }, include: { definition: true } });
  for (const e of lapsed) {
    await prisma.earnedCertification.update({ where: { id: e.id }, data: { status: 'EXPIRED' } });
    await notifyOnce(e.profileId, `cert-expired:${e.id}`, { type: 'certification.expired', title: 'Certification expired', body: `"${e.definition.name}" has expired.${e.definition.renewalNote ? ' ' + e.definition.renewalNote : ''}`, link: '/dashboard' });
    expired += 1;
  }
  if (!definitions.length) return { issued, expired };
  const people = await prisma.profile.findMany({ where: { organizationId, status: 'ACTIVE', role: { in: ['TRAVEL_AGENT', 'FLIGHT_EXPERT', 'SUPERVISOR'] } } });
  for (const def of definitions) {
    for (const person of people) { if (await issueIfEligible(def, person, { now })) issued += 1; }
  }
  return { issued, expired };
}

module.exports = { normalizeRequirements, evaluate, issueIfEligible, evaluateOrganization, CONF_RANK };
