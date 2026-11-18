'use strict';

const { randomUUID } = require('node:crypto');
const { prisma } = require('./prisma');
const mailer = require('./mailer');
const { formatDeadline } = require('./trainingDeadline');
const { isSubmitted, courseAttempt } = require('./trainingCompletion');
const { getSetting } = require('./orgSettings');
// A training that has been assigned gets ONE assignment email, then ONE reminder every N days until it is completed.
// N is set per training by an Admin (Manage Training -> Training emails): every day (default), 2 or 3 days, or weekly.
const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REMINDER_CHOICES = [1, 2, 3, 7];   // the ready-made choices; an Admin can also enter any number of days (Custom)
const MAX_REMINDER_DAYS = 60;
const validDays = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_REMINDER_DAYS;
const everyDays = (course) => (validDays(course && course.reminderEveryDays) ? course.reminderEveryDays : 1);
const intervalMs = (course) => everyDays(course) * REMINDER_INTERVAL_MS;
/** "once a day" / "every 2 days" / "once a week": how the emails describe the cadence. */
const cadenceText = (days) => (days === 1 ? 'once a day' : days === 7 ? 'once a week' : `every ${days} days`);
const RETRY_CAP_MS = 3 * 60 * 60 * 1000; // a failed delivery is retried with a growing delay, never longer than this
const LEASE_MS = 2 * 60 * 1000;
const POLL_MS = 15000;
let timer;
let running = false;

// Enqueue in the SAME transaction as the assignment: no email for rolled-back assignments.
async function enqueueAssignment(tx, recipientId, now = new Date()) {
  return tx.trainingEmailSchedule.upsert({ where: { recipientId }, create: { recipientId, nextSendAt: now }, update: {} });
}

async function queueAgain(recipientIds, now = new Date()) {
  let queued = 0;
  for (const recipientId of recipientIds) {
    const current = await enqueueAssignment(prisma, recipientId, now);
    // Preserve a pending delivery/retry, including its provider idempotency key.
    if (current.kind === 'ASSIGNED' && current.nextSendAt) { queued++; continue; }
    const changed = await prisma.trainingEmailSchedule.updateMany({
      where: { recipientId, claimToken: null, payloadJson: null, AND: [
        { OR: [{ kind: 'REMINDER' }, { nextSendAt: null }] },
        { OR: [{ lastSentAt: null }, { lastSentAt: { lte: new Date(now.getTime() - 60000) } }] },
      ] },
      data: { kind: 'ASSIGNED', nextSendAt: now, sequence: { increment: 1 }, payloadJson: null, retryCount: 0, lastError: null },
    });
    queued += changed.count;
  }
  return queued;
}

// Finished = the same rule as everywhere else in the app (My Training, dashboards, reports): the training was submitted
// and no retake was asked for since. Submitting already required every practice to be passed. The worker used to
// re-check the practices against the training as it is NOW, so editing a finished training (a practice added, a pass
// mark or required attempts raised) made people who had finished it get the "not completed yet" link every day.
function completed(recipient) {
  return isSubmitted(recipient.attempts);
}

// The same training finished in another copy of it after this copy was assigned (two assignments of one training, e.g.
// a practice-only one and the whole training): this copy is done too. A copy assigned AFTER they finished is a new
// round on purpose and still gets its emails. The whole training covers a practice-only copy, not the other way round.
async function finishedInAnotherCopy(recipient) {
  const others = await prisma.trainingAssignmentRecipient.findMany({
    where: { profileId: recipient.profileId, id: { not: recipient.id }, assignment: { courseId: recipient.assignment.courseId } },
    select: { assignment: { select: { assessmentId: true } }, attempts: { where: { assessmentId: null }, select: { status: true, attemptNumber: true, createdAt: true, completedAt: true, assessmentId: true } } },
  });
  return others.some((o) => {
    if (o.assignment.assessmentId && o.assignment.assessmentId !== recipient.assignment.assessmentId) return false;
    const c = courseAttempt(o.attempts);
    return Boolean(c && c.status === 'COMPLETED' && c.completedAt && new Date(c.completedAt) >= new Date(recipient.createdAt));
  });
}

// Admin switches (Manage Training -> Training emails): the whole company, the person's teams, this training.
async function emailsOff(recipient) {
  if (recipient.assignment.course.trainingEmailsOff) return 'Paused: emails are off for this training';
  if (!(await getSetting(recipient.assignment.organizationId, 'email.trainingEmails'))) return 'Paused: training emails are off';
  const off = await prisma.teamMembership.findFirst({ where: { profileId: recipient.profileId, team: { trainingEmailsOff: true, archivedAt: null } }, select: { id: true } });
  return off ? "Paused: emails are off for this person's team" : null;
}
const PAUSED = /^Paused: /;

/** Stops the emails of a training the moment it is finished (this copy, and older copies it covers). */
async function stopForFinished(recipient) {
  const covered = await prisma.trainingAssignmentRecipient.findMany({
    where: { profileId: recipient.profileId, createdAt: { lte: new Date() }, assignment: { courseId: recipient.assignment.courseId, ...(recipient.assignment.assessmentId ? { assessmentId: recipient.assignment.assessmentId } : {}) } },
    select: { id: true },
  });
  const ids = [recipient.id, ...covered.map((c) => c.id)];
  return prisma.trainingEmailSchedule.updateMany({ where: { recipientId: { in: ids }, claimToken: null }, data: { nextSendAt: null, payloadJson: null, lastError: null } });
}

/** An Admin changed how often a training reminds: its queued reminders follow the new interval from the last email. */
async function rescheduleCourse(courseId, days, now = new Date()) {
  const jobs = await prisma.trainingEmailSchedule.findMany({ where: { kind: 'REMINDER', claimToken: null, nextSendAt: { not: null }, lastSentAt: { not: null }, recipient: { assignment: { courseId } } }, select: { recipientId: true, lastSentAt: true } });
  for (const j of jobs) {
    const next = new Date(Math.max(j.lastSentAt.getTime() + days * REMINDER_INTERVAL_MS, now.getTime()));
    await prisma.trainingEmailSchedule.updateMany({ where: { recipientId: j.recipientId, claimToken: null }, data: { nextSendAt: next } });
  }
  return jobs.length;
}

/** An Admin turned emails back on: paused emails are looked at again now (each is re-checked before sending). */
async function resumePaused(organizationId) {
  const r = await prisma.trainingEmailSchedule.updateMany({ where: { lastError: { startsWith: 'Paused: ' }, claimToken: null, recipient: { assignment: { organizationId } } }, data: { nextSendAt: new Date(), lastError: null } });
  kick();
  return r.count;
}

function eligibility(recipient) {
  const p = recipient.profile, a = recipient.assignment;
  if (p.organizationId !== a.organizationId || a.course.organizationId !== a.organizationId) return 'Assignment organization mismatch';
  if (!['ACTIVE', 'INVITED'].includes(p.status) || p.archivedAt || p.testOwnerAdminId) return 'Recipient is inactive, archived or a test profile';
  if (a.course.status !== 'PUBLISHED' || a.course.archivedAt) return 'Training is no longer published';
  if (completed(recipient)) return 'Training completed';
  return null;
}

// Short and clear: what, by when, and one link. Reminders say how long they will keep coming.
function messageFor(recipient, kind, now = new Date()) {
  const a = recipient.assignment;
  const url = new URL(`/training-course/${a.courseId}`, process.env.ACCOUNT_EMAIL_ORIGIN || process.env.APP_ORIGIN).href;
  const reminder = kind === 'REMINDER';
  const first = String(recipient.profile.fullName || '').trim().split(/\s+/)[0] || 'there';
  const overdue = Boolean(a.dueDate && a.dueDate < now);
  const due = a.dueDate ? `Due: ${formatDeadline(a.dueDate)}${overdue ? ' - overdue' : ''}\n` : '';
  const intro = reminder
    ? `Your training "${a.course.title}" is not completed yet${overdue ? ' and is overdue' : ''}.`
    : `A new training was assigned to you: "${a.course.title}".`;
  const invited = recipient.profile.status === 'INVITED' ? '\nFirst, activate your account with your invitation email.\n' : '';
  const cadence = cadenceText(everyDays(a.course));
  const footer = reminder ? `You will get this reminder ${cadence} until you complete it.` : `If it is not completed, we will remind you ${cadence}.`;
  return {
    from: process.env.RESEND_FROM || process.env.SMTP_FROM,
    to: recipient.profile.email,
    subject: reminder ? `${overdue ? 'Overdue' : 'Reminder'}: ${a.course.title}` : `New training: ${a.course.title}`,
    text: `Hi ${first},\n\n${intro}\n${due}\nOpen it: ${url}\n${invited}\n${footer}\n\nSpaceZero Workspace`,
  };
}

async function processNext({ now = new Date(), send = mailer.sendEmailMessage } = {}) {
  const available = { nextSendAt: { lte: now }, OR: [{ claimToken: null }, { claimedAt: { lt: new Date(now.getTime() - LEASE_MS) } }] };
  const job = await prisma.trainingEmailSchedule.findFirst({ where: available, orderBy: { nextSendAt: 'asc' } });
  if (!job) return false;
  const token = randomUUID();
  const claim = await prisma.trainingEmailSchedule.updateMany({ where: { ...available, recipientId: job.recipientId, sequence: job.sequence }, data: { claimToken: token, claimedAt: now } });
  if (!claim.count) return true;
  const finish = data => prisma.trainingEmailSchedule.updateMany({ where: { recipientId: job.recipientId, claimToken: token }, data: { ...data, claimToken: null, claimedAt: null } });
  try {
    const recipient = await prisma.trainingAssignmentRecipient.findUnique({ where: { id: job.recipientId }, include: { profile: true, assignment: { include: { course: { include: { assessments: true } } } }, attempts: true } });
    if (!recipient) return true; // FK cascade already removed the job.
    // Everything required done but never submitted: finish it now (as the app does), then there is nothing to remind.
    if (!completed(recipient) && recipient.profile.status === 'ACTIVE') {
      const { autoFinishForProfile } = require('./trainingCompletion');
      if (await autoFinishForProfile(recipient.profileId, { id: recipient.id }).catch(() => 0)) recipient.attempts = await prisma.trainingAttempt.findMany({ where: { recipientId: recipient.id } });
    }
    const reason = eligibility(recipient) || (await finishedInAnotherCopy(recipient) ? 'Training completed' : null);
    if (reason) { await finish({ nextSendAt: null, payloadJson: null, lastError: reason === 'Training completed' ? null : reason }); return true; }
    const paused = await emailsOff(recipient);
    if (paused) { await finish({ nextSendAt: new Date(now.getTime() + REMINDER_INTERVAL_MS), lastError: paused }); return true; }   // nothing sent; turning it back on resumes
    if (job.kind === 'REMINDER') {
      // the training's interval after the last email, however the deadline stands
      const earliest = new Date((job.lastSentAt ? job.lastSentAt.getTime() : 0) + intervalMs(recipient.assignment.course));
      if (now < earliest) { await finish({ nextSendAt: earliest, payloadJson: null }); return true; }
    }
    if (!mailer.isEmailConfigured() && send === mailer.sendEmailMessage) throw new Error('Email is not configured');
    const message = job.payloadJson ? JSON.parse(job.payloadJson) : messageFor(recipient, job.kind, now);
    if (!job.payloadJson) await prisma.trainingEmailSchedule.updateMany({ where: { recipientId: job.recipientId, claimToken: token }, data: { payloadJson: JSON.stringify(message) } });
    await send(message, { idempotencyKey: `training-${job.recipientId}-${job.sequence}` });
    // Successful delivery acceptance controls the interval; retry attempts do not advance it.
    await finish({ lastSentAt: now, ...(job.kind === 'ASSIGNED' ? { assignmentSentAt: now } : {}), kind: 'REMINDER', sequence: { increment: 1 }, nextSendAt: new Date(now.getTime() + intervalMs(recipient.assignment.course)), payloadJson: null, retryCount: 0, lastError: null });
  } catch {
    // Do not record provider response bodies, tokens or the email payload in logs.
    await finish({ nextSendAt: new Date(now.getTime() + Math.min(RETRY_CAP_MS, 30000 * 2 ** Math.min(job.retryCount, 9))), retryCount: { increment: 1 }, lastError: 'Email was not accepted. It will be retried automatically.' });
  }
  return true;
}

async function drain() {
  if (running) return;
  running = true;
  try {
    for (let i = 0; i < 20 && await processNext(); i++) {
      // Pace bulk delivery; failed/provider-limited requests remain in the durable queue.
      await new Promise(resolve => setTimeout(resolve, 600));
    }
  }
  finally { running = false; }
}
function kick() {
  if (process.env.NODE_ENV === 'test' || process.env.VERCEL) return;
  setImmediate(() => drain().catch(err => console.error('[trainingEmails]', err.code || 'worker failed')));
}
function start() {
  if (timer || process.env.NODE_ENV === 'test' || process.env.VERCEL) return;
  timer = setInterval(kick, POLL_MS);
  timer.unref();
  kick();
}
function stop() { if (timer) clearInterval(timer); timer = null; }
module.exports = { enqueueAssignment, queueAgain, processNext, drain, kick, start, stop, completed, finishedInAnotherCopy, stopForFinished, resumePaused, emailsOff, PAUSED, REMINDER_INTERVAL_MS, REMINDER_CHOICES, MAX_REMINDER_DAYS, validDays, cadenceText, rescheduleCourse };
