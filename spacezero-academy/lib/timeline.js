'use strict';

// A human-readable timeline of one employee's journey (created -> activated -> set up -> trained -> skills),
// built from the records that actually hold each fact (profile, invitation, setup items, assignments,
// attempts, skill evidence, vacation requests, certifications). It is NOT the security audit log: raw audit
// entries (logins, credential access, permission changes) stay on the Admin's Security & Audit screen and
// never appear here. The caller has already authorized who may look at this employee.
const { prisma } = require('./prisma');

const pct = (n) => (typeof n === 'number' ? `${Math.round(n)}%` : null);
const firstName = (p) => (p && p.fullName ? p.fullName : null);
const dayText = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const SOURCE_TEXT = { ASSESSMENT: 'assessment', PRACTICE: 'practice', CALL_REVIEW: 'analyzed call', MANUAL_ADJUSTMENT: 'supervisor assessment' };

async function employeeTimeline(employee, { limit = 80 } = {}) {
  const id = employee.id;
  const [invitation, items, recipients, attempts, evidence, leave, certs] = await Promise.all([
    prisma.invitation.findFirst({ where: { profileId: id }, select: { acceptedAt: true } }),
    prisma.employeeSetupItem.findMany({ where: { profileId: id }, include: { requirement: { select: { label: true } }, verifiedBy: { select: { fullName: true } } } }),
    prisma.trainingAssignmentRecipient.findMany({ where: { profileId: id }, include: { assignment: { select: { createdAt: true, dueDate: true, courseVersion: true, assignedBy: { select: { fullName: true } }, course: { select: { title: true } }, assessmentId: true } } } }),
    prisma.trainingAttempt.findMany({ where: { profileId: id, status: { in: ['COMPLETED', 'RETAKE_REQUIRED', 'FAILED'] } }, include: { assessment: { select: { title: true } }, recipient: { select: { assignment: { select: { course: { select: { title: true } } } } } } } }),
    prisma.skillEvidence.findMany({ where: { employeeSkill: { profileId: id } }, include: { employeeSkill: { select: { skill: { select: { name: true } } } } }, orderBy: { createdAt: 'desc' }, take: 40 }),
    prisma.leaveRequest.findMany({ where: { profileId: id }, select: { createdAt: true, status: true, reviewedAt: true, startDate: true, endDate: true, leaveType: true } }),
    prisma.earnedCertification.findMany({ where: { profileId: id }, include: { definition: { select: { name: true, kind: true } } } }),
  ]);

  const assessmentTitles = new Map((await prisma.assessment.findMany({ where: { id: { in: recipients.map((r) => r.assignment.assessmentId).filter(Boolean) } }, select: { id: true, title: true } })).map((a) => [a.id, a.title]));
  const events = [{ at: employee.createdAt, kind: 'profile', text: 'Profile created' }];
  if (invitation && invitation.acceptedAt) events.push({ at: invitation.acceptedAt, kind: 'profile', text: 'Profile activated' });

  for (const item of items) {
    const label = item.requirement.label;
    if (item.verifiedAt && item.status === 'COMPLETED') events.push({ at: item.verifiedAt, kind: 'setup', text: `${label} verified${item.verifiedBy ? ` by ${item.verifiedBy.fullName}` : ''}` });
    else if (item.employeeConfirmedAt) events.push({ at: item.employeeConfirmedAt, kind: 'setup', text: `${label} confirmed by the employee` });
    if (item.status === 'ISSUE') events.push({ at: item.updatedAt, kind: 'setup', text: `${label} has an issue`, detail: item.note || null });
  }

  for (const r of recipients) {
    const a = r.assignment;
    const what = a.assessmentId && assessmentTitles.get(a.assessmentId) ? `${assessmentTitles.get(a.assessmentId)} (${a.course.title})` : a.course.title;
    events.push({ at: a.createdAt, kind: 'training', text: `Training assigned: ${what}${a.courseVersion > 1 ? ` (version ${a.courseVersion})` : ''}`, detail: [firstName(a.assignedBy) ? `by ${a.assignedBy.fullName}` : null, a.dueDate ? `due ${dayText(a.dueDate)}` : null].filter(Boolean).join(' · ') || null });
  }
  for (const t of attempts) {
    const title = t.assessment ? t.assessment.title : t.recipient.assignment.course.title;
    const when = t.completedAt || t.updatedAt;
    if (t.status === 'COMPLETED') events.push({ at: when, kind: 'training', text: t.assessment ? `Practice passed — ${title}${pct(t.score) ? ` — ${pct(t.score)}` : ''}` : `Training completed — ${title}${pct(t.score) ? ` — ${pct(t.score)}` : ''}` });
    else events.push({ at: when, kind: 'training', text: `Retake required — ${title}${pct(t.score) ? ` (scored ${pct(t.score)})` : ''}` });
  }

  for (const e of evidence) events.push({ at: e.createdAt, kind: 'skill', text: `Skill evidence added — ${e.employeeSkill.skill.name}${typeof e.scoreImpact === 'number' ? ` (${Math.round(e.scoreImpact)}% from ${SOURCE_TEXT[e.sourceType] || 'evidence'})` : ''}` });

  for (const l of leave) {
    const kind = l.leaveType === 'VACATION' ? 'Vacation' : 'Leave';
    events.push({ at: l.createdAt, kind: 'leave', text: `${kind} requested`, detail: `${dayText(l.startDate)} – ${dayText(l.endDate)}` });
    if (l.status === 'APPROVED' && l.reviewedAt) events.push({ at: l.reviewedAt, kind: 'leave', text: `${kind} approved` });
    if (l.status === 'REJECTED' && l.reviewedAt) events.push({ at: l.reviewedAt, kind: 'leave', text: `${kind} declined` });
  }

  for (const c of certs) events.push({ at: c.issuedAt, kind: 'skill', text: `${c.definition.kind === 'ACHIEVEMENT' ? 'Achievement' : 'Certification'} earned — ${c.definition.name}` });

  return events.filter((e) => e.at).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
}

module.exports = { employeeTimeline };
