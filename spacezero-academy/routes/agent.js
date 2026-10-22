'use strict';

const express = require('express');
const router = express.Router();

const { prisma } = require('../lib/prisma');
const { requireSession, requireRole } = require('../lib/authMiddleware');
const { getMyTrainingList } = require('../lib/training');
const { pathOf } = require('../lib/myTraining');
const { startTraining } = require('../lib/trainingCompletion');

// One path through the learner's training in a fixed order (lib/myTraining.js pathOf), with one main button.
router.get('/training', requireSession, async (req, res) => {
  // Anything already done (every practice passed, material finished) is finished now - it must not sit in Overdue.
  if (!require('../lib/requestContext').readOnly()) await require('../lib/trainingCompletion').autoFinishForProfile(req.profile.id).catch((err) => console.error('auto-finish failed', err.message));
  const path = pathOf(await getMyTrainingList(req.profile.id, { progress: true }));
  res.render('training', { title: 'My Training', path });
});

router.post('/training/:recipientId/start', requireSession, async (req, res) => {
  const recipient = await prisma.trainingAssignmentRecipient.findUnique({ where: { id: req.params.recipientId }, include: { attempts: true } });
  if (recipient && recipient.profileId === req.profile.id) await startTraining(recipient);
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
    const { completionState, finishTraining } = require('../lib/trainingCompletion');
    const state = await completionState(recipient);
    if (!state.passedAll) return res.status(403).send('Pass all required assessments before completing this training.');
    // Submitting twice (a double tap, a stale page) changes nothing and sends no second certificate or notice.
    await finishTraining(recipient);
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
