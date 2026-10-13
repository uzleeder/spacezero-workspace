'use strict';

const { randomUUID } = require('node:crypto');
const { prisma } = require('./prisma');
const mailer = require('./mailer');
const { formatDeadline } = require('./trainingDeadline');
const THREE_HOURS = 3 * 60 * 60 * 1000;
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

// Passing one component is not enough for a multi-assessment course.
function completed(recipient) {
  const attempts = [...recipient.attempts].sort((a, b) => b.attemptNumber - a.attemptNumber);
  if (!attempts.length || ['RETAKE_REQUIRED', 'FAILED', 'NOT_STARTED', 'IN_PROGRESS'].includes(attempts[0].status)) return false;
  const a = recipient.assignment;
  const required = a.course.assessments.filter(x => x.status === 'APPROVED' && !x.archivedAt && x.version === a.courseVersion && (!a.assessmentId || x.id === a.assessmentId) && !JSON.parse(x.configJson || '{}').targetedRetake);
  if (!required.length) return attempts[0].status === 'COMPLETED';
  return required.every(x => attempts.filter(t => t.assessmentId === x.id && t.completedAt).length >= a.requiredAttempts && attempts.some(t => t.assessmentId === x.id && t.status === 'COMPLETED' && t.score >= Math.max(x.passingScore, a.minimumScore)));
}

function eligibility(recipient) {
  const p = recipient.profile, a = recipient.assignment;
  if (p.organizationId !== a.organizationId || a.course.organizationId !== a.organizationId) return 'Assignment organization mismatch';
  if (!['ACTIVE', 'INVITED'].includes(p.status) || p.archivedAt || p.testOwnerAdminId) return 'Recipient is inactive, archived or a test profile';
  if (a.course.status !== 'PUBLISHED' || a.course.archivedAt) return 'Training is no longer published';
  if (completed(recipient)) return 'Training completed';
  return null;
}

function messageFor(recipient, kind) {
  const a = recipient.assignment;
  const url = new URL(`/training-course/${a.courseId}`, process.env.ACCOUNT_EMAIL_ORIGIN || process.env.APP_ORIGIN).href;
  const reminder = kind === 'REMINDER';
  return {
    from: process.env.RESEND_FROM || process.env.SMTP_FROM,
    to: recipient.profile.email,
    subject: `${reminder ? 'Overdue training reminder' : 'Training assigned'}: ${a.course.title}`,
    text: `Hello ${recipient.profile.fullName},\n\n${reminder ? 'Your assigned training is overdue and still needs to be completed.' : 'New training has been assigned to you in SpaceZero Workspace.'}\n\nTraining: ${a.course.title}\nDue: ${formatDeadline(a.dueDate)}\nMinimum score: ${a.minimumScore}%\nRequired attempts: ${a.requiredAttempts}${a.notes ? `\nNotes: ${a.notes}` : ''}\n\nOpen your training:\n${url}\n\n${recipient.profile.status === 'INVITED' ? 'Activate your account using your invitation email before signing in. If the invitation expired, contact your administrator.\n\n' : ''}${a.dueDate ? 'If this training remains incomplete after its deadline, you will receive an email reminder every 3 hours. Reminders stop when the training is completed.' : 'No deadline has been set, so no overdue reminders are scheduled.'}\n\nSpaceZero Workspace\nCrafted by UZLEEDER`,
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
    const due = recipient.assignment.dueDate;
    if (job.kind === 'REMINDER') {
      if (!due) { await finish({ nextSendAt: null, payloadJson: null }); return true; }
      const earliest = new Date(Math.max(due.getTime(), job.lastSentAt?.getTime() || 0) + THREE_HOURS);
      if (now < earliest) { await finish({ nextSendAt: earliest, payloadJson: null }); return true; }
    }
    if (!mailer.isEmailConfigured() && send === mailer.sendEmailMessage) throw new Error('Email is not configured');
    const message = job.payloadJson ? JSON.parse(job.payloadJson) : messageFor(recipient, job.kind);
    if (!job.payloadJson) await prisma.trainingEmailSchedule.updateMany({ where: { recipientId: job.recipientId, claimToken: token }, data: { payloadJson: JSON.stringify(message) } });
    await send(message, { idempotencyKey: `training-${job.recipientId}-${job.sequence}` });
    // Successful delivery acceptance controls the interval; retry attempts do not advance it.
    await finish({ lastSentAt: now, ...(job.kind === 'ASSIGNED' ? { assignmentSentAt: now } : {}), kind: 'REMINDER', sequence: { increment: 1 }, nextSendAt: due ? new Date(Math.max(now.getTime(), due.getTime()) + THREE_HOURS) : null, payloadJson: null, retryCount: 0, lastError: null });
  } catch {
    // Do not record provider response bodies, tokens or the email payload in logs.
    await finish({ nextSendAt: new Date(now.getTime() + Math.min(THREE_HOURS, 30000 * 2 ** Math.min(job.retryCount, 9))), retryCount: { increment: 1 }, lastError: 'Email was not accepted. It will be retried automatically.' });
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
module.exports = { enqueueAssignment, queueAgain, processNext, drain, kick, start, stop, completed, THREE_HOURS };
