'use strict';

const { randomUUID } = require('node:crypto');
const { prisma } = require('./prisma');
const mailer = require('./mailer');
const { formatDeadline } = require('./trainingDeadline');
const { completionFromAssessments } = require('./trainingCompletion');
// A training that has been assigned gets ONE assignment email, then a reminder every 6 hours until it is completed.
const SIX_HOURS = 6 * 60 * 60 * 1000;
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

// Practice passes and the final Submit training action must both be complete.
function completed(recipient) {
  const state = completionFromAssessments(recipient, recipient.assignment.course.assessments);
  return state.passedAll && state.submitted;
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
  const footer = reminder ? 'You will get this reminder every 6 hours until you complete it.' : 'If it is not completed, we will remind you every 6 hours.';
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
    const reason = eligibility(recipient);
    if (reason) { await finish({ nextSendAt: null, payloadJson: null, lastError: reason === 'Training completed' ? null : reason }); return true; }
    if (job.kind === 'REMINDER') {
      // every 6 hours after the last email, however the deadline stands
      const earliest = new Date((job.lastSentAt ? job.lastSentAt.getTime() : 0) + SIX_HOURS);
      if (now < earliest) { await finish({ nextSendAt: earliest, payloadJson: null }); return true; }
    }
    if (!mailer.isEmailConfigured() && send === mailer.sendEmailMessage) throw new Error('Email is not configured');
    const message = job.payloadJson ? JSON.parse(job.payloadJson) : messageFor(recipient, job.kind, now);
    if (!job.payloadJson) await prisma.trainingEmailSchedule.updateMany({ where: { recipientId: job.recipientId, claimToken: token }, data: { payloadJson: JSON.stringify(message) } });
    await send(message, { idempotencyKey: `training-${job.recipientId}-${job.sequence}` });
    // Successful delivery acceptance controls the interval; retry attempts do not advance it.
    await finish({ lastSentAt: now, ...(job.kind === 'ASSIGNED' ? { assignmentSentAt: now } : {}), kind: 'REMINDER', sequence: { increment: 1 }, nextSendAt: new Date(now.getTime() + SIX_HOURS), payloadJson: null, retryCount: 0, lastError: null });
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
module.exports = { enqueueAssignment, queueAgain, processNext, drain, kick, start, stop, completed, SIX_HOURS };
