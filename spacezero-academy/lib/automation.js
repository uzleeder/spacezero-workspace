'use strict';

// Development automation: onboarding paths, assignment rules, retention follow-ups, reminders and
// alerts, certification checks. It runs on a schedule (and on demand for an Admin) and is IDEMPOTENT:
// every path step, rule, retention check and notification carries a key, so running it twice never
// duplicates anything.
//
// Safety: the automation can RECOMMEND, and can auto-ASSIGN only an already published, approved
// training that an Admin explicitly attached to a rule/step with action ASSIGN. It never changes
// scores, permissions or roles, never publishes anything, and never assigns AI-generated draft material.
const { prisma } = require('./prisma');
const { getSetting } = require('./orgSettings');
const engine = require('./skillEngine');
const { notifyOnce } = require('./notifications');
const { evaluateOrganization } = require('./certifications');
const { logAudit } = require('./audit');
const { CONF_RANK } = require('./certifications');
const { registerJobType } = require('./jobQueue');
const { runOnboarding } = require('./onboarding');
const { coversSkill, estimateMinutes } = require('./development');
const { liveVersion } = require('./courseVersions');
const { runPassportReminders } = require('./passport');

const DAY_MS = 86400000;
const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

async function supervisorsOf(profileId) {
  const rows = await prisma.supervisorAssignment.findMany({ where: { agentId: profileId, unassignedAt: null }, select: { supervisorId: true } });
  return rows.map((r) => r.supervisorId);
}

/** The most targeted approved practice of a training for one skill: micro-practice first, then any practice that covers it. */
async function findPractice(courseId, skillName) {
  const owner = await prisma.trainingCourse.findUnique({ where: { id: courseId }, select: { publishedVersion: true } });
  const list = await prisma.assessment.findMany({ where: { courseId, status: 'APPROVED', archivedAt: null, version: liveVersion(owner || {}) }, include: { questions: { select: { skillIdsJson: true } } } });
  const covering = list.filter((a) => coversSkill(a, skillName) && parse(a.configJson, {})?.targetedRetake !== true);
  return covering.find((a) => parse(a.configJson, {})?.micro === true) || covering[0] || null;
}

/** Creates a recommendation once per (employee, sourceKey). Returns the row when new, null when it already existed. */
async function recommendOnce(data) {
  if (await alreadyHandled(data.profileId, data.sourceKey)) return null; // the common case: skip quietly instead of relying on the unique-key error
  try {
    return await prisma.developmentRecommendation.create({ data });
  } catch (err) {
    if (err && err.code === 'P2002') return null;
    throw err;
  }
}

async function alreadyHandled(profileId, sourceKey) {
  return Boolean(await prisma.developmentRecommendation.findUnique({ where: { profileId_sourceKey: { profileId, sourceKey } }, select: { id: true } }));
}

/** Creates a real individual assignment of an approved, published course/practice — used only for explicit ASSIGN actions. */
async function autoAssign({ organizationId, courseId, assessmentId, profileId, assignedById, note }) {
  const course = await prisma.trainingCourse.findFirst({ where: { id: courseId || '', organizationId, status: 'PUBLISHED', archivedAt: null } });
  if (!course) return null; // drafts and archived training are never auto-assigned
  if (assessmentId) {
    const ok = await prisma.assessment.findFirst({ where: { id: assessmentId, courseId, status: 'APPROVED', archivedAt: null, version: liveVersion(course) } });
    if (!ok) return null;
  }
  const existing = await prisma.trainingAssignmentRecipient.findFirst({ where: { profileId, assignment: { courseId, assessmentId: assessmentId || null } }, include: { attempts: { select: { status: true }, orderBy: { attemptNumber: 'desc' }, take: 1 } } });
  if (existing && (!existing.attempts[0] || existing.attempts[0].status !== 'COMPLETED')) return null; // already open
  const floor = await getSetting(organizationId, 'training.minPassingScore');
  return prisma.$transaction(async (tx) => {
    const assignment = await tx.trainingAssignment.create({ data: { organizationId, courseId, assessmentId: assessmentId || null, assignedById, scope: 'INDIVIDUAL', notes: note, courseVersion: liveVersion(course), minimumScore: Math.max(floor, course.passingScore) } });
    const recipient = await tx.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId } });
    await tx.trainingAttempt.create({ data: { recipientId: recipient.id, profileId, status: 'NOT_STARTED', attemptNumber: 1 } });
    return assignment;
  });
}

// ------------------------------------------------------------------ retention
async function scheduleRetention(organizationId, now) {
  const schedule = await getSetting(organizationId, 'retention.schedule');
  const recent = await prisma.trainingAttempt.findMany({
    where: { status: 'COMPLETED', completedAt: { gte: new Date(now.getTime() - 400 * DAY_MS) }, recipient: { assignment: { organizationId } } },
    select: { recipientId: true, profileId: true, completedAt: true, recipient: { select: { assignment: { select: { courseId: true } } } } },
    orderBy: { completedAt: 'asc' },
  });
  const first = new Map();
  for (const a of recent) if (!first.has(a.recipientId)) first.set(a.recipientId, a);
  const known = new Set((await prisma.retentionCheck.findMany({ where: { recipientId: { in: [...first.keys()] } }, select: { recipientId: true, offsetDays: true } })).map((k) => `${k.recipientId}|${k.offsetDays}`));
  let created = 0;
  for (const a of first.values()) {
    for (const days of schedule) {
      if (known.has(`${a.recipientId}|${days}`)) continue;
      try {
        await prisma.retentionCheck.create({ data: { organizationId, recipientId: a.recipientId, profileId: a.profileId, courseId: a.recipient.assignment.courseId, offsetDays: days, dueAt: new Date(a.completedAt.getTime() + days * DAY_MS) } });
        created += 1;
      } catch (err) { if (!(err && err.code === 'P2002')) throw err; }
    }
  }
  return created;
}

async function processRetention(organizationId, now) {
  const [schedule, declinePoints] = await Promise.all([getSetting(organizationId, 'retention.schedule'), getSetting(organizationId, 'retention.declinePoints')]);
  const firstOffset = schedule[0];
  const due = await prisma.retentionCheck.findMany({ where: { organizationId, status: 'PENDING', dueAt: { lte: now } }, orderBy: { dueAt: 'asc' }, take: 500 });
  const out = { checked: 0, declined: 0, reinforcements: 0 };
  for (const check of due) {
    const [course, profile] = await Promise.all([
      prisma.trainingCourse.findUnique({ where: { id: check.courseId }, include: { analysis: true } }),
      prisma.profile.findUnique({ where: { id: check.profileId } }),
    ]);
    if (!course || !profile || profile.status !== 'ACTIVE') { await prisma.retentionCheck.update({ where: { id: check.id }, data: { status: 'DONE', outcome: 'SKIPPED', checkedAt: now } }); continue; }
    const names = parse(course.analysis && course.analysis.extractedSkillsJson, []).map((n) => String(n).trim().toLowerCase());
    // name matching is case-insensitive, so it is done in memory
    const all = names.length ? await prisma.employeeSkill.findMany({ where: { profileId: profile.id, evidenceCount: { gt: 0 }, skill: { organizationId, isActive: true } }, include: { skill: true } }) : [];
    const targeted = all.filter((s) => names.includes(s.skill.name.trim().toLowerCase()));
    let outcome = 'HELD'; const detail = [];
    for (const es of targeted) {
      const history = await prisma.skillScoreHistory.findMany({ where: { employeeSkillId: es.id, recordedAt: { gte: new Date(check.dueAt.getTime() - check.offsetDays * DAY_MS - 3600000) } }, orderBy: { recordedAt: 'asc' }, select: { score: true, recordedAt: true } });
      const peak = history.length ? Math.max(...history.filter((h) => h.recordedAt <= check.dueAt).map((h) => h.score), 0) : es.currentScore;
      const drop = Math.round(peak - es.currentScore);
      detail.push({ skill: es.skill.name, peak: Math.round(peak), now: Math.round(es.currentScore), drop });
      if (drop >= declinePoints || es.currentScore < 70) {
        outcome = 'DECLINED';
        const practice = await findPractice(course.id, es.skill.name);
        const created = await recommendOnce({
          organizationId, profileId: profile.id, assessmentId: practice ? practice.id : null, kind: 'RETENTION', source: 'RETENTION', sourceKey: `retention:${check.recipientId}:${es.skillId}`, skillId: es.skillId, courseId: course.id,
          title: `Refresh ${es.skill.name} (${check.offsetDays}-day check)`, reason: `${es.skill.name} was ${Math.round(peak)}% after "${course.title}" and is ${Math.round(es.currentScore)}% now${drop > 0 ? ` (down ${drop} points)` : ''}. A short targeted practice is recommended — not the whole training again.`, priority: 520, estimatedMinutes: practice ? estimateMinutes(practice) : 3,
        });
        if (created) {
          out.declined += 1;
          await notifyOnce(profile.id, `retention:${created.id}`, { type: 'development.recommended', title: 'A short refresher is recommended', body: `${es.skill.name} has slipped since your training.`, link: '/dashboard' });
          if (drop >= declinePoints * 2) for (const sup of await supervisorsOf(profile.id)) await notifyOnce(sup, `decline:${es.id}:${check.offsetDays}`, { type: 'skill.decline', title: `Major skill decline: ${profile.fullName}`, body: `${es.skill.name} dropped ${drop} points since training.`, link: `/employees/${profile.id}/skills` });
        }
      }
    }
    if (check.offsetDays === firstOffset && targeted.length) {
      const es = targeted[0];
      const practice = await findPractice(course.id, es.skill.name);
      const created = await recommendOnce({ organizationId, profileId: profile.id, assessmentId: practice ? practice.id : null, kind: 'REINFORCEMENT', source: 'RETENTION', sourceKey: `reinforce:${check.recipientId}`, skillId: es.skillId, courseId: course.id, title: `3-minute reinforcement: ${es.skill.name}`, reason: `A short reinforcement ${check.offsetDays} days after "${course.title}" helps the skill stick.`, priority: 130, estimatedMinutes: 3 });
      if (created) out.reinforcements += 1;
    }
    await prisma.retentionCheck.update({ where: { id: check.id }, data: { status: 'DONE', outcome: targeted.length ? outcome : 'NO_SKILLS', detailJson: JSON.stringify(detail), checkedAt: now } });
    out.checked += 1;
  }
  return out;
}

// ------------------------------------------------------------------ onboarding paths
async function runPaths(organizationId, now) {
  const paths = await prisma.developmentPath.findMany({ where: { organizationId, isActive: true }, include: { steps: true } });
  const out = { recommended: 0, assigned: 0 };
  for (const path of paths) {
    if (!path.steps.length) continue;
    const people = await prisma.profile.findMany({ where: { organizationId, status: 'ACTIVE', role: path.roleKey || { in: ['TRAVEL_AGENT', 'FLIGHT_EXPERT', 'SUPERVISOR'] } } });
    for (const person of people) {
      const age = Math.floor((now - person.employmentStartDate) / DAY_MS);
      for (const step of path.steps) {
        // A step fires once it is due, within a 30-day grace window (older steps of a new path are treated as missed, not fired all at once).
        if (age < step.dayOffset || age > step.dayOffset + 30) continue;
        const key = `path:${step.id}`;
        const base = { organizationId, profileId: person.id, kind: 'ONBOARDING', source: 'PATH', sourceKey: key, courseId: step.courseId, assessmentId: step.assessmentId, title: step.title, reason: `Onboarding path "${path.name}" — day ${step.dayOffset}.`, priority: 380, estimatedMinutes: null };
        if (await alreadyHandled(person.id, key)) continue;
        if (step.autoAssign && step.courseId) {
          const assignment = await autoAssign({ organizationId, courseId: step.courseId, assessmentId: step.assessmentId, profileId: person.id, assignedById: path.createdById, note: `Onboarding: ${path.name}` });
          if (assignment) {
            const rec = await recommendOnce({ ...base, status: 'ASSIGNED', resolvedAt: now });
            if (rec) { out.assigned += 1; await notifyOnce(person.id, `path:${step.id}`, { type: 'training.assigned', title: 'New training assigned', body: `${step.title} (onboarding).`, link: '/training' }); }
            continue;
          }
        }
        if (await recommendOnce(base)) out.recommended += 1;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ rules
async function ruleMatches(rule, person, skillRows, now) {
  const c = parse(rule.conditionJson, {});
  if (rule.roleKey && rule.roleKey !== person.role) return null;
  const age = Math.floor((now - person.employmentStartDate) / DAY_MS);
  if (Number.isFinite(c.minAgeDays) && age < c.minAgeDays) return null;
  if (Number.isFinite(c.maxAgeDays) && age > c.maxAgeDays) return null;
  let because = [];
  if (Number.isFinite(c.minAgeDays)) because.push(`${age} days since start`);
  if (c.skillId) {
    const row = skillRows.find((s) => s.skillId === c.skillId && s.evidenceCount > 0);
    if (!row || row.currentScore >= c.below || (CONF_RANK[row.confidenceLevel] || 0) < (CONF_RANK[c.minConfidence] || 0)) return null;
    because.push(`${row.skill.name} is ${Math.round(row.currentScore)}% (${row.confidenceLevel.toLowerCase()} evidence confidence)`);
  }
  if (c.retakeOutstanding) {
    const outstanding = await prisma.trainingAssignmentRecipient.count({ where: { profileId: person.id, attempts: { some: { status: 'RETAKE_REQUIRED' } } } });
    if (!outstanding) return null;
    because.push('a retake is outstanding');
  }
  if (!because.length && !Number.isFinite(c.minAgeDays) && !c.skillId && !c.retakeOutstanding) return null; // an empty rule would match everybody: never
  return because.join('; ');
}

async function runRules(organizationId, now) {
  const rules = await prisma.assignmentRule.findMany({ where: { organizationId, isActive: true } });
  const out = { recommended: 0, assigned: 0 };
  if (!rules.length) return out;
  const people = await prisma.profile.findMany({ where: { organizationId, status: 'ACTIVE', role: { in: ['TRAVEL_AGENT', 'FLIGHT_EXPERT', 'SUPERVISOR'] } } });
  const skillRows = await prisma.employeeSkill.findMany({ where: { profileId: { in: people.map((p) => p.id) }, evidenceCount: { gt: 0 } }, include: { skill: true } });
  const courses = new Map((await prisma.trainingCourse.findMany({ where: { organizationId, id: { in: rules.map((r) => r.courseId).filter(Boolean) } }, select: { id: true, title: true } })).map((c) => [c.id, c]));
  for (const rule of rules) {
    for (const person of people) {
      const because = await ruleMatches(rule, person, skillRows.filter((s) => s.profileId === person.id), now);
      if (because === null) continue;
      const course = rule.courseId ? courses.get(rule.courseId) : null;
      const base = { organizationId, profileId: person.id, kind: 'RULE', source: 'RULE', sourceKey: `rule:${rule.id}`, courseId: rule.courseId, assessmentId: rule.assessmentId, title: course ? course.title : rule.name, reason: `Rule "${rule.name}": ${because}.`, priority: 300 };
      if (await alreadyHandled(person.id, base.sourceKey)) continue;
      if (rule.action === 'ASSIGN' && rule.courseId) {
        const assignment = await autoAssign({ organizationId, courseId: rule.courseId, assessmentId: rule.assessmentId, profileId: person.id, assignedById: rule.createdById, note: `Automatic rule: ${rule.name}` });
        if (assignment) {
          if (await recommendOnce({ ...base, status: 'ASSIGNED', resolvedAt: now })) { out.assigned += 1; await notifyOnce(person.id, `rule:${rule.id}`, { type: 'training.assigned', title: 'New training assigned', body: `${base.title} was assigned to you (${rule.name}).`, link: '/training' }); }
          continue;
        }
      }
      if (await recommendOnce(base)) out.recommended += 1; // recommendation is the default and the fallback
    }
  }
  return out;
}

// ------------------------------------------------------------------ reminders and alerts
async function runNotifications(organizationId, now) {
  const dueSoonDays = await getSetting(organizationId, 'dev.dueSoonDays');
  const declinePoints = await getSetting(organizationId, 'retention.declinePoints');
  const out = { dueSoon: 0, overdue: 0, supervisor: 0, admin: 0 };
  const recipients = await prisma.trainingAssignmentRecipient.findMany({
    where: { assignment: { organizationId, dueDate: { not: null }, course: { status: 'PUBLISHED', archivedAt: null } }, profile: { status: 'ACTIVE' } },
    include: { assignment: { select: { dueDate: true, course: { select: { title: true } } } }, attempts: { select: { status: true, attemptNumber: true }, orderBy: { attemptNumber: 'desc' }, take: 1 }, profile: { select: { id: true, fullName: true } } },
  });
  for (const r of recipients) {
    if (r.attempts[0] && r.attempts[0].status === 'COMPLETED') continue;
    const due = r.assignment.dueDate; const title = r.assignment.course.title;
    if (due < now) {
      if (await notifyOnce(r.profileId, `overdue:${r.id}`, { type: 'training.overdue', title: 'Training overdue', body: `"${title}" was due ${due.toISOString().slice(0, 10)}.`, link: '/training' })) out.overdue += 1;
      for (const sup of await supervisorsOf(r.profileId)) if (await notifyOnce(sup, `overdue:${r.id}:sup`, { type: 'training.overdue', title: `Overdue: ${r.profile.fullName}`, body: `"${title}" is overdue.`, link: `/employees/${r.profileId}/training` })) out.supervisor += 1;
    } else if (due - now <= dueSoonDays * DAY_MS) {
      if (await notifyOnce(r.profileId, `due-soon:${r.id}`, { type: 'training.due_soon', title: 'Training due soon', body: `"${title}" is due ${due.toISOString().slice(0, 10)}.`, link: '/training' })) out.dueSoon += 1;
    }
  }

  // Supervisors: an agent failed, failed repeatedly, or completed practice the supervisor assigned (recent events only).
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const attempts = await prisma.trainingAttempt.findMany({
    where: { updatedAt: { gte: since }, status: { in: ['RETAKE_REQUIRED', 'FAILED', 'COMPLETED'] }, assessmentId: { not: null }, recipient: { assignment: { organizationId } } },
    include: { profile: { select: { id: true, fullName: true } }, assessment: { select: { title: true } }, recipient: { select: { id: true, assignment: { select: { assignedById: true } }, attempts: { select: { status: true } } } } },
  });
  for (const a of attempts) {
    const sups = await supervisorsOf(a.profileId);
    if (a.status === 'COMPLETED') {
      const assigner = a.recipient.assignment.assignedById;
      if (assigner && assigner !== a.profileId && (sups.includes(assigner)) && await notifyOnce(assigner, `completed:${a.id}`, { type: 'practice.completed', title: `Practice completed: ${a.profile.fullName}`, body: `${a.assessment.title}${a.score !== null ? ` — ${Math.round(a.score)}%` : ''}.`, link: `/employees/${a.profileId}/skills` })) out.supervisor += 1;
      continue;
    }
    const failures = a.recipient.attempts.filter((x) => x.status === 'RETAKE_REQUIRED' || x.status === 'FAILED').length;
    for (const sup of sups) {
      if (await notifyOnce(sup, `failed:${a.id}`, { type: 'training.failed', title: `${a.profile.fullName} did not pass`, body: `${a.assessment.title}${a.score !== null ? ` — ${Math.round(a.score)}%` : ''}. A retake is required.`, link: `/employees/${a.profileId}/skills` })) out.supervisor += 1;
      if (failures >= 2 && await notifyOnce(sup, `repeat-failed:${a.recipient.id}`, { type: 'training.repeated_failure', title: `${a.profile.fullName} has failed repeatedly`, body: `${failures} attempts of ${a.assessment.title} were below the pass mark — consider coaching.`, link: `/employees/${a.profileId}/skills` })) out.supervisor += 1;
    }
  }

  // Major decline in the last 30 days.
  const slipping = await prisma.employeeSkill.findMany({ where: { evidenceCount: { gt: 1 }, lastEvidenceAt: { gte: new Date(now.getTime() - 30 * DAY_MS) }, profile: { organizationId, status: 'ACTIVE' } }, include: { skill: true, profile: { select: { id: true, fullName: true } } }, take: 2000 });
  if (slipping.length) {
    const hist = await prisma.skillScoreHistory.findMany({ where: { employeeSkillId: { in: slipping.map((s) => s.id) }, recordedAt: { gte: new Date(now.getTime() - 60 * DAY_MS) } }, orderBy: { recordedAt: 'asc' }, select: { employeeSkillId: true, score: true, recordedAt: true } });
    const by = new Map();
    for (const h of hist) { const l = by.get(h.employeeSkillId) || []; l.push(h); by.set(h.employeeSkillId, l); }
    for (const s of slipping) {
      const t = engine.trendOf(by.get(s.id) || [], { now });
      if (t.direction === 'declining' && t.delta <= -(declinePoints * 2)) {
        for (const sup of await supervisorsOf(s.profile.id)) if (await notifyOnce(sup, `decline:${s.id}:${now.toISOString().slice(0, 7)}`, { type: 'skill.decline', title: `Major skill decline: ${s.profile.fullName}`, body: `${s.skill.name} dropped ${Math.abs(t.delta)} points.`, link: `/employees/${s.profile.id}/skills` })) out.supervisor += 1;
      }
    }
  }

  // Admins: processing failures in the last two days (analysis or call batches).
  const admins = await prisma.profile.findMany({ where: { organizationId, role: 'ADMIN', status: 'ACTIVE', testOwnerAdminId: null }, select: { id: true } });
  const recent = new Date(now.getTime() - 2 * DAY_MS);
  const failedBatches = await prisma.callBatch.findMany({ where: { organizationId, status: 'FAILED', updatedAt: { gte: recent } }, select: { id: true } });
  const failedAnalyses = await prisma.trainingAnalysis.findMany({ where: { status: 'FAILED', course: { organizationId }, updatedAt: { gte: recent } }, select: { id: true, courseId: true } });
  for (const admin of admins) {
    for (const b of failedBatches) if (await notifyOnce(admin.id, `proc-fail:call:${b.id}`, { type: 'processing.failed', title: 'Call processing failed', body: 'A call batch failed to process. Open it to retry.', link: `/ai-practice/calls/${b.id}` })) out.admin += 1;
    for (const a of failedAnalyses) if (await notifyOnce(admin.id, `proc-fail:analysis:${a.id}`, { type: 'processing.failed', title: 'Training analysis failed', body: 'A training analysis failed. Open it to retry.', link: `/admin/training/${a.courseId}/analysis` })) out.admin += 1;
  }
  return out;
}

/** An overdue setup item reminds ITS OWNER (the employee, their supervisor, or the admins) once. */
async function runSetupReminders(organizationId) {
  const { loadSetupForProfiles } = require('./employeeSetup');
  const people = await prisma.profile.findMany({ where: { organizationId, status: 'ACTIVE', testOwnerAdminId: null } });
  const setups = await loadSetupForProfiles(organizationId, people);
  const admins = (await prisma.profile.findMany({ where: { organizationId, role: 'ADMIN', status: 'ACTIVE', testOwnerAdminId: null }, select: { id: true } })).map((a) => a.id);
  let sent = 0;
  for (const person of people) {
    for (const row of setups.get(person.id).overdueRows) {
      const owners = row.ownerRole === 'EMPLOYEE' ? [person.id] : row.ownerRole === 'SUPERVISOR' ? await supervisorsOf(person.id) : row.ownerRole === 'ADMIN' ? admins : [];
      for (const ownerId of owners) {
        const mine = ownerId === person.id;
        if (await notifyOnce(ownerId, `setup-overdue:${person.id}:${row.requirement.id}`, { type: 'setup.overdue', title: mine ? 'Setup item overdue' : `Setup overdue: ${person.fullName}`, body: `${row.requirement.label} was due ${row.dueAt.toISOString().slice(0, 10)}.`, link: await require('./supervisorCapabilities').setupLinkFor(ownerId, person.id) })) sent += 1;
      }
    }
  }
  return sent;
}

/** One full pass for one organization. Safe to run repeatedly. */
async function runAutomation(organizationId, { now = new Date(), actorId = null } = {}) {
  const summary = {};
  summary.retentionScheduled = await scheduleRetention(organizationId, now);
  summary.retention = await processRetention(organizationId, now);
  summary.paths = await runPaths(organizationId, now);
  summary.onboarding = await runOnboarding(organizationId, { now });
  summary.setupReminders = await runSetupReminders(organizationId);
  summary.passportReminders = await runPassportReminders(organizationId, now);
  summary.rules = await runRules(organizationId, now);
  summary.notifications = await runNotifications(organizationId, now);
  summary.certifications = await evaluateOrganization(organizationId, { now });
  await logAudit({ organizationId, actorId, action: 'automation.run', targetTable: 'Organization', targetId: organizationId, metadata: { retention: summary.retention, paths: summary.paths, rules: summary.rules, certifications: summary.certifications } });
  return summary;
}

// Runs every six hours from the in-process job poller (never in tests), for every organization.
const EVERY_MS = 6 * 60 * 60 * 1000;
let lastRun = 0;
registerJobType({
  name: 'developmentAutomation',
  async findNext() {
    if (Date.now() - lastRun < EVERY_MS) return null;
    lastRun = Date.now();
    return { id: 'development-automation', run: async () => { for (const org of await prisma.organization.findMany({ select: { id: true } })) await runAutomation(org.id); } };
  },
  async requeueStuck() {},
});

module.exports = { runAutomation, scheduleRetention, processRetention, runPaths, runRules, runNotifications, ruleMatches, recommendOnce, autoAssign };
