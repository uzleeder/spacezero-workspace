'use strict';

const express = require('express');
const router = express.Router();

const { prisma } = require('../lib/prisma');
const { requireRole } = require('../lib/authMiddleware');
const { isSupervisorOfAgent, teamIdsForSupervisor, supervisedProfileIds } = require('../lib/authz');
const { AssignmentSchema } = require('../lib/validation');
const { logAudit } = require('../lib/audit');
const { createNotificationForMany } = require('../lib/notifications');
const { excludeOtherAdminsTestProfiles } = require('../lib/loginAsScope');
const { getSetting } = require('../lib/orgSettings');
const { describeAudience } = require('../lib/courseAudience');
const { assignableCoursesWhere, canAssignCourse } = require('../lib/trainingPermissions');
const { liveVersion } = require('../lib/courseVersions');
const { hasCapability } = require('../lib/supervisorCapabilities');

// A Supervisor has no assign access at all until an Admin grants 'training.assign' — separate from,
// and in addition to, the per-course assignPolicy/TrainingAssignGrant check further down (which
// governs WHICH courses; this governs whether they may assign anything at all).
const mayUseAssignForm = async (req, res, next) => {
  if (req.profile.role !== 'SUPERVISOR') return next();
  if (await hasCapability(req.profile, 'training.assign')) return next();
  return res.status(403).render('forbidden');
};

async function loadFormData(actor) {
  const courses = await prisma.trainingCourse.findMany({
    where: assignableCoursesWhere(actor), // Admin: every approved course; Supervisor: only those the Admin allows them to assign
    orderBy: { title: 'asc' },
    include: { assessments: { where: { status: 'APPROVED' } } },
  });
  for (const c of courses) c.assessments = c.assessments.filter((a) => a.version === liveVersion(c)); // only the version that is in Training can be assigned
  let teams;
  let people;
  if (actor.role === 'ADMIN') {
    teams = await prisma.team.findMany({ where: { organizationId: actor.organizationId, archivedAt: null }, orderBy: { name: 'asc' } });
    people = await prisma.profile.findMany({
      where: { organizationId: actor.organizationId, status: { not: 'ARCHIVED' }, ...excludeOtherAdminsTestProfiles(actor) },
      orderBy: { fullName: 'asc' },
    });
  } else {
    const teamIds = await teamIdsForSupervisor(actor.id);
    teams = await prisma.team.findMany({ where: { id: { in: teamIds } } });
    const agentIds = await supervisedProfileIds(actor.id);
    people = await prisma.profile.findMany({ where: { id: { in: agentIds }, status: { not: 'ARCHIVED' } }, orderBy: { fullName: 'asc' } });
  }
  return { courses, teams, people };
}

/** Pre-fills the assign form from the chosen training (intended audience, due date) and an optional employee. Guidance only. */
async function formHints(actor, courses, people, query) {
  const selectedCourseId = typeof query.courseId === 'string' ? query.courseId : '';
  const course = courses.find((c) => c.id === selectedCourseId) || null;
  const personId = typeof query.personId === 'string' && people.some((p) => p.id === query.personId) ? query.personId : '';
  const minimumScoreFloor = await getSetting(actor.organizationId, 'training.minPassingScore');
  return {
    selectedCourseId,
    selectedPersonId: personId,
    audienceHint: course ? await describeAudience(actor, course) : null,
    defaultDueDate: course && course.defaultDueDate ? course.defaultDueDate.toISOString().slice(0, 10) : '',
    defaultMinimumScore: Math.max(minimumScoreFloor, course ? course.passingScore : 0),
    minimumScoreFloor,
  };
}

router.get('/assignments', requireRole('ADMIN', 'SUPERVISOR'), mayUseAssignForm, async (req, res) => {
  const actor = req.profile;
  const { courses, teams, people } = await loadFormData(actor);
  const assignments = await prisma.trainingAssignment.findMany({
    where: actor.role === 'ADMIN' ? { organizationId: actor.organizationId } : { assignedById: actor.id },
    include: { course: true, _count: { select: { recipients: true } } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  res.render('assignments', {
    ...(await formHints(actor, courses, people, req.query)),
    title: 'Training',
    courses,
    teams,
    people,
    assignments,
    allowCompany: actor.role === 'ADMIN',
    error: null,
  });
});

router.post('/assignments', requireRole('ADMIN', 'SUPERVISOR'), mayUseAssignForm, async (req, res) => {
  const actor = req.profile;
  const targetProfileIds = Array.isArray(req.body.targetProfileIds)
    ? req.body.targetProfileIds
    : req.body.targetProfileIds
    ? [req.body.targetProfileIds]
    : [];

  const parsed = AssignmentSchema.safeParse({
    courseId: req.body.courseId,
    scope: req.body.scope,
    targetProfileIds,
    targetTeamId: req.body.targetTeamId || undefined,
    targetTeamIds: [].concat(req.body.targetTeamIds || []).map(String),
    targetRole: req.body.targetRole || undefined,
    dueDate: req.body.dueDate || undefined,
    notes: req.body.notes || undefined,
  });

  const rerenderError = async (error) => {
    const { courses, teams, people } = await loadFormData(actor);
    const assignments = await prisma.trainingAssignment.findMany({
      where: actor.role === 'ADMIN' ? { organizationId: actor.organizationId } : { assignedById: actor.id },
      include: { course: true, _count: { select: { recipients: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    res.render('assignments', { title: 'Training', courses, teams, people, assignments, allowCompany: actor.role === 'ADMIN', error });
  };

  if (!parsed.success) return rerenderError('Please complete the assignment form correctly.');
  const data = parsed.data;
  const assessmentId = req.body.assessmentId || null;
  const requiredAttempts = Number(req.body.requiredAttempts || 1);
  const minimumScoreFloor = await getSetting(actor.organizationId, 'training.minPassingScore');
  const minimumScore = Number(req.body.minimumScore || minimumScoreFloor);
  if (!Number.isInteger(requiredAttempts) || requiredAttempts < 1 || requiredAttempts > 20 || !Number.isInteger(minimumScore) || minimumScore < minimumScoreFloor || minimumScore > 100) return rerenderError(`Required attempts must be 1–20; minimum score must be ${minimumScoreFloor}–100.`);
  if (assessmentId) {
    const selected = await prisma.assessment.findFirst({ where: { id: assessmentId, courseId: data.courseId, organizationId: actor.organizationId, status: 'APPROVED', version: liveVersion(await prisma.trainingCourse.findUnique({ where: { id: data.courseId }, select: { publishedVersion: true } }) || {}) } });
    if (!selected || JSON.parse(selected.configJson || '{}').targetedRetake) return rerenderError('Choose approved practice belonging to this course.');
  }

  if (actor.role === 'SUPERVISOR' && data.scope === 'COMPANY') {
    return rerenderError('Only administrators can assign training company-wide.');
  }

  // One "group" per assignment record: an individual list, each chosen team, a role group, or everyone.
  const groups = [];
  if (data.scope === 'INDIVIDUAL') {
    const recipients = [...new Set(data.targetProfileIds || [])];
    if (recipients.length === 0) return rerenderError('Select at least one recipient.');
    if (actor.role === 'SUPERVISOR') {
      for (const id of recipients) {
        if (!(await isSupervisorOfAgent(actor.id, id))) return rerenderError('You can only assign training to your own team.');
      }
    }
    groups.push({ scope: 'INDIVIDUAL', recipients });
  } else if (data.scope === 'TEAM') {
    const teamIds = [...new Set([...(data.targetTeamIds || []), ...(data.targetTeamId ? [data.targetTeamId] : [])])];
    if (teamIds.length === 0) return rerenderError('Select at least one team.');
    if (actor.role === 'SUPERVISOR') {
      const myTeamIds = await teamIdsForSupervisor(actor.id);
      if (teamIds.some((id) => !myTeamIds.includes(id))) return rerenderError('You can only assign training to your own team.');
    }
    for (const teamId of teamIds) {
      const members = await prisma.teamMembership.findMany({ where: { teamId, team: { organizationId: actor.organizationId } }, select: { profileId: true } });
      const authorized = req.authorizedTeamRecipients && req.authorizedTeamRecipients.get(teamId);
      groups.push({ scope: 'TEAM', targetTeamId: teamId, recipients: authorized || members.map((m) => m.profileId) });
    }
  } else if (data.scope === 'ROLE') {
    if (actor.role !== 'ADMIN') return rerenderError('Only administrators can assign training to a role group.');
    if (!data.targetRole) return rerenderError('Choose a role group.');
    const people = await prisma.profile.findMany({ where: { organizationId: actor.organizationId, role: data.targetRole, status: { not: 'ARCHIVED' }, ...excludeOtherAdminsTestProfiles(actor) }, select: { id: true } });
    groups.push({ scope: 'ROLE', targetRole: data.targetRole, recipients: people.map((p) => p.id) });
  } else {
    const everyone = await prisma.profile.findMany({
      where: { organizationId: actor.organizationId, status: { not: 'ARCHIVED' }, ...excludeOtherAdminsTestProfiles(actor) },
      select: { id: true },
    });
    groups.push({ scope: 'COMPANY', recipients: everyone.map((p) => p.id) });
  }
  const populated = groups.filter((g) => g.recipients.length > 0);
  if (populated.length === 0) return rerenderError('No recipients matched this assignment.');

  const course = await prisma.trainingCourse.findUnique({ where: { id: data.courseId } });
  if (!course) return rerenderError('Course not found.');
  if (!await canAssignCourse(actor, course)) return res.status(403).render('forbidden');

  await prisma.$transaction(async (tx) => {
    for (const group of populated) {
      const assignment = await tx.trainingAssignment.create({
        data: {
          organizationId: actor.organizationId,
          courseId: data.courseId,
          courseVersion: liveVersion(course),
          assignedById: actor.id,
          scope: group.scope,
          targetTeamId: group.targetTeamId,
          targetRole: group.targetRole,
          dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
          notes: data.notes,
          assessmentId,
          requiredAttempts,
          minimumScore,
        },
      });
      for (const profileId of group.recipients) {
        const recipient = await tx.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId } });
        await tx.trainingAttempt.create({ data: { recipientId: recipient.id, profileId, status: 'NOT_STARTED', attemptNumber: 1 } });
      }
    }
  });

  const recipientIds = [...new Set(populated.flatMap((g) => g.recipients))];
  await logAudit({
    organizationId: actor.organizationId,
    actorId: actor.id,
    action: 'training.assigned',
    targetTable: 'TrainingCourse',
    targetId: data.courseId,
    metadata: { scope: data.scope, groups: populated.length, recipientCount: recipientIds.length, ...(data.targetRole ? { role: data.targetRole } : {}) },
  });

  await createNotificationForMany(recipientIds, {
    type: 'training.assigned',
    title: 'New training assigned',
    body: `"${course.title}" was assigned to you.`,
    link: '/training',
  });

  res.redirect('/assignments');
});

module.exports = router;
