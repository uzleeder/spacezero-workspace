'use strict';

const express = require('express');
const router = express.Router();

const { prisma } = require('../lib/prisma');
const { requireSession, requireRole } = require('../lib/authMiddleware');
const { getMyTrainingList } = require('../lib/training');
const { buildMyTraining } = require('../lib/myTraining');
const trainingCategories = require('../lib/trainingCategories');
const { createNotification } = require('../lib/notifications');

// One page: choose a STATUS (Overdue / To Do / In Progress / Completed) and a CATEGORY (All / Product / Sales /
// System & Workflow) - no separate pages for every combination.
router.get('/training', requireSession, async (req, res) => {
  const list = await getMyTrainingList(req.profile.id);
  const view = buildMyTraining(list, { status: typeof req.query.status === 'string' ? req.query.status : '', category: typeof req.query.category === 'string' ? req.query.category : '' });
  res.render('training', { title: 'My Training', list, view, categoryLabel: trainingCategories.categoryLabel });
});

async function latestAttemptFor(recipientId) {
  return prisma.trainingAttempt.findFirst({ where: { recipientId }, orderBy: { attemptNumber: 'desc' } });
}

router.post('/training/:recipientId/start', requireSession, async (req, res) => {
  const recipient = await prisma.trainingAssignmentRecipient.findUnique({ where: { id: req.params.recipientId } });
  if (recipient && recipient.profileId === req.profile.id) {
    const latest = await latestAttemptFor(recipient.id);
    if (latest && latest.status === 'NOT_STARTED') {
      await prisma.trainingAttempt.update({ where: { id: latest.id }, data: { status: 'IN_PROGRESS', startedAt: new Date() } });
    } else if (latest && latest.status === 'RETAKE_REQUIRED') {
      await prisma.trainingAttempt.create({
        data: { recipientId: recipient.id, profileId: req.profile.id, attemptNumber: latest.attemptNumber + 1, status: 'IN_PROGRESS', startedAt: new Date() },
      });
    }
  }
  const started = recipient && recipient.profileId === req.profile.id ? await prisma.trainingAssignment.findUnique({ where: { id: recipient.assignmentId }, select: { courseId: true } }) : null;
  res.redirect(started ? `/training-course/${started.courseId}` : '/training'); // "Start" opens the training itself
});

router.post('/training/:recipientId/complete', requireSession, async (req, res) => {
  const recipient = await prisma.trainingAssignmentRecipient.findUnique({
    where: { id: req.params.recipientId },
    include: { assignment: { include: { course: true } }, attempts: true },
  });
  if (recipient && recipient.profileId === req.profile.id) {
    if (!(await require('../lib/mediaProgress').mediaGate(req.profile.id, recipient.assignment.courseId, recipient.assignment.courseVersion)).unlocked) return res.status(403).send('Complete all required training material first.');
    const { completionState, submitTraining } = require('../lib/trainingCompletion');
    const state = await completionState(recipient);
    if (!state.passedAll) return res.status(403).send('Pass all required assessments before completing this training.');
    // Submitting twice (a double tap, a stale page) changes nothing and sends no second certificate or notice.
    if (!state.submitted) {
      await submitTraining(recipient);

      await prisma.certificate
        .create({
          data: {
            profileId: req.profile.id,
            courseId: recipient.assignment.courseId,
            title: recipient.assignment.course.title,
            description: 'Training course completed.',
          },
        })
        .catch(() => undefined);

      await createNotification({
        profileId: req.profile.id,
        type: 'training.completed',
        title: 'Course completed',
        body: `You completed "${recipient.assignment.course.title}". A certificate was added to your profile.`,
        link: '/profile',
      });
    }
  }
  res.redirect('/training');
});

// /skill-graph is now the Skill DNA page (routes/skillDna.js).

// Recommended-practice used to live on its own page; it's now a panel on
// Skill Graph, so this old link still resolves for anyone with it bookmarked.
router.get('/practice', requireRole('TRAVEL_AGENT', 'FLIGHT_EXPERT'), (req, res) => {
  res.redirect('/skill-graph');
});

module.exports = router;
