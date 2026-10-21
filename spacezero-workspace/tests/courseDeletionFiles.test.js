'use strict';
// Deleting a training also removes the voice recordings of its practice, and the log keeps who lost how many attempts.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { prisma } = require('../lib/prisma');
const { resolveStoragePath } = require('../lib/storage');
const { deleteCourse } = require('../lib/courseDeletion');

let org, admin, agent;
before(async () => {
  org = await prisma.organization.create({ data: { name: 'Course deletion files' } });
  const mk = (role, name) => prisma.profile.create({ data: { organizationId: org.id, fullName: `CD ${name}`, username: `cd_${org.id}_${name}`, email: `cd_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  admin = await mk('ADMIN', 'admin'); agent = await mk('TRAVEL_AGENT', 'agent');
});
after(async () => { await prisma.$disconnect(); });

test('the recordings of a deleted training leave the disk too, and the log names who had attempts', async () => {
  const dir = resolveStoragePath('voice-drafts'); fs.mkdirSync(dir, { recursive: true });
  const answer = `voice-drafts/cd-answer-${Date.now()}.webm`; const draft = `voice-drafts/cd-draft-${Date.now()}.webm`; const keep = `voice-drafts/cd-other-${Date.now()}.webm`;
  for (const p of [answer, draft, keep]) fs.writeFileSync(resolveStoragePath(p), 'x');
  const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Voice course', createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1 } });
  const assessment = await prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdVia: 'ADMIN_MANUAL', type: 'VOICE', status: 'APPROVED', title: 'Voice', createdById: admin.id, version: 1 } });
  const a = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  const recipient = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: agent.id } });
  await prisma.trainingAttempt.create({ data: { recipientId: recipient.id, profileId: agent.id, assessmentId: assessment.id, status: 'COMPLETED', score: 88, attemptNumber: 1, completedAt: new Date(), answersJson: JSON.stringify({ recording: { storagePath: answer, mimeType: 'audio/webm' }, feedback: 'ok' }) } });
  await prisma.practiceSession.create({ data: { profileId: agent.id, assessmentId: assessment.id, dataJson: JSON.stringify({ draft: { storagePath: draft, mimeType: 'audio/webm' } }) } });

  await deleteCourse(admin, course);

  assert.equal(fs.existsSync(resolveStoragePath(answer)), false);                      // the attempt's recording is gone
  assert.equal(fs.existsSync(resolveStoragePath(draft)), false);                       // so is an unsent draft
  assert.equal(fs.existsSync(resolveStoragePath(keep)), true);                         // anything else is untouched
  const entry = await prisma.auditLog.findFirst({ where: { actorId: admin.id, action: 'training.course_deleted' } });
  assert.deepEqual(JSON.parse(entry.metadataJson).attemptsByPerson, [{ profileId: agent.id, attempts: 1, bestScore: 88 }]);
  fs.unlinkSync(resolveStoragePath(keep));
});
