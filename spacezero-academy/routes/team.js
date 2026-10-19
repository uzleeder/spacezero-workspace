'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');

const { prisma } = require('../lib/prisma');
const { containsText } = require('../lib/textSearch');
const { parseFilters, whereFor, applyLearningFilters, byReadiness, byPassportStatus } = require('../lib/employeeFilters');
const { STATUS: PASSPORT_STATUS, STATUS_LABEL: PASSPORT_STATUS_LABEL } = require('../lib/passport');
const { readinessFor } = require('../lib/readiness');
const { requireRole } = require('../lib/authMiddleware');
const { supervisedProfileIds, isSupervisorOfAgent } = require('../lib/authz');
const { getTrainingSummaries, getMyTrainingList } = require('../lib/training');
const { retakeTarget } = require('../lib/trainingCompletion');
const { loadProfileOverview } = require('../lib/profileOverview');
const { tabsForRequest } = require('../lib/employeeTabs');
const { loadSetupForProfiles } = require('../lib/employeeSetup');
const { SETUP_FILTERS, parseSetupQuery, matchesSetup, requirementOptions } = require('../lib/employeeList');
const { validateUpload, saveUpload } = require('../lib/storage');
const { logAudit } = require('../lib/audit');
const { createNotification } = require('../lib/notifications');
const { hasCapability } = require('../lib/supervisorCapabilities');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });

router.get('/team', requireRole('SUPERVISOR'), async (req, res) => {
  const agentIds = await supervisedProfileIds(req.profile.id);
  const str = (v) => (typeof v === 'string' ? v : '');
  const setupQuery = parseSetupQuery(req.query);
  const status = str(req.query.status);
  const f = parseFilters(req.query);
  const found = await prisma.profile.findMany({
    where: { id: { in: agentIds }, status: status || undefined, ...(str(req.query.q).trim() ? { OR: [{ fullName: containsText(req.query.q) }, { email: containsText(req.query.q) }, { username: containsText(req.query.q) }] } : {}), ...(await whereFor(req.profile.organizationId, f)) },
    include: { teamMemberships: { include: { team: true } } },
    orderBy: { fullName: 'asc' },
  });
  const setupMap = await loadSetupForProfiles(req.profile.organizationId, found);
  const readinessMap = await readinessFor(req.profile.organizationId, found, { setupMap });
  const agents = byPassportStatus(byReadiness(await applyLearningFilters(found, f), readinessMap, f), f);
  const shown = agents.filter((a) => matchesSetup(setupMap.get(a.id), setupQuery));
  const trainingMap = await getTrainingSummaries(shown.map((a) => a.id)); // one query for everyone, not one per row
  const summaries = shown.map((agent) => ({ agent, summary: trainingMap.get(agent.id), setup: setupMap.get(agent.id), readiness: readinessMap.get(agent.id) }));
  res.render('team/index', {
    title: 'Employees & Teams', summaries, f, filterSkills: await prisma.skill.findMany({ where: { organizationId: req.profile.organizationId, isActive: true }, orderBy: [{ category: 'asc' }, { name: 'asc' }], select: { id: true, name: true } }), SETUP_FILTERS, requirements: await requirementOptions(req.profile.organizationId),
    q: str(req.query.q), status, setup: setupQuery.setup, missing: setupQuery.missing,
    PASSPORT_STATUS, PASSPORT_STATUS_LABEL,
  });
});

router.get('/team/:id', requireRole('SUPERVISOR'), async (req, res) => {
  const allowed = await isSupervisorOfAgent(req.profile.id, req.params.id);
  if (!allowed) return res.status(403).render('forbidden');

  const data = await loadProfileOverview(req.params.id);
  if (!data) return res.status(404).render('not-found', { layout: false });

  // "View Team Training History & Reassign/Retake" is its own Admin-grantable capability — a
  // Supervisor may see the rest of this page (setup, skills, overview) without it; only the
  // training-history section and the retake action are gated on it.
  const canViewTrainingHistory = req.profile.role === 'ADMIN' || await hasCapability(req.profile, 'training.viewHistory');
  const trainingList = canViewTrainingHistory ? await getMyTrainingList(req.params.id) : [];
  const retakeCandidates = trainingList.filter((r) => r.status === 'COMPLETED' || r.status === 'FAILED');

  res.locals.empTabs = await tabsForRequest(req, data.profile);
  res.render('team/detail', { title: data.profile.fullName, data, retakeCandidates, canRecordEvidence: true, canViewTrainingHistory });
});

// /team-skills is now Team Intelligence (routes/teamIntel.js).

router.post('/training/:recipientId/retake', requireRole('ADMIN', 'SUPERVISOR'), async (req, res) => {
  const actor = req.profile;
  if (actor.role === 'SUPERVISOR' && !(await hasCapability(actor, 'training.viewHistory'))) return res.status(403).render('forbidden');
  const recipient = await prisma.trainingAssignmentRecipient.findFirst({ where: { id: req.params.recipientId, assignment: { organizationId: actor.organizationId }, profile: { organizationId: actor.organizationId } } });
  if (recipient) {
    if (actor.role === 'SUPERVISOR' && !(await isSupervisorOfAgent(actor.id, recipient.profileId))) {
      return res.status(403).render('forbidden');
    }
    // Re-opens the training's submission (not whichever practice attempt happens to have the highest number).
    const latest = retakeTarget(await prisma.trainingAttempt.findMany({ where: { recipientId: recipient.id } }));
    if (latest) {
      await prisma.trainingAttempt.update({
        where: { id: latest.id },
        data: { status: 'RETAKE_REQUIRED', retakeRequestedById: actor.id, retakeRequestedAt: new Date() },
      });
      await logAudit({
        organizationId: actor.organizationId,
        actorId: actor.id,
        action: 'training.retake_requested',
        targetTable: 'TrainingAssignmentRecipient',
        targetId: recipient.id,
      });
      await require('../lib/trainingEmails').queueAgain([recipient.id]);
      require('../lib/trainingEmails').kick();
      await createNotification({
        profileId: recipient.profileId,
        type: 'training.retake_requested',
        title: 'Retake requested',
        body: 'Your supervisor requested a retake for a completed course.',
        link: '/training',
      });
    }
  }
  res.redirect('/team');
});

// ---- Call Reviews ----

router.get('/call-reviews', requireRole('SUPERVISOR'), async (req, res) => {
  const agentIds = await supervisedProfileIds(req.profile.id);
  const [agents, reviews] = await Promise.all([
    prisma.profile.findMany({ where: { id: { in: agentIds }, status: { not: 'ARCHIVED' } }, orderBy: { fullName: 'asc' } }),
    prisma.callReview.findMany({
      where: { supervisorId: req.profile.id, organizationId: req.profile.organizationId, agentId: { in: agentIds } },
      include: { agent: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  res.render('call-reviews', { title: 'Call reviews', agents, reviews, error: null });
});

router.post('/call-reviews', requireRole('SUPERVISOR'), upload.single('recording'), async (req, res) => {
  const actor = req.profile;
  const agentId = req.body.agentId;
  const allowed = agentId && (await isSupervisorOfAgent(actor.id, agentId));
  if (!allowed) return res.status(403).render('forbidden');

  let storagePath;
  let mimeType;
  if (req.file) {
    const validationError = validateUpload('CALL_RECORDING', req.file);
    if (validationError) {
      const agentIds = await supervisedProfileIds(actor.id);
      const [agents, reviews] = await Promise.all([
        prisma.profile.findMany({ where: { id: { in: agentIds } } }),
        prisma.callReview.findMany({ where: { supervisorId: actor.id, organizationId: actor.organizationId, agentId: { in: agentIds } }, include: { agent: true }, orderBy: { createdAt: 'desc' } }),
      ]);
      return res.render('call-reviews', { title: 'Call reviews', agents, reviews, error: validationError });
    }
    const saved = await saveUpload(req.file, 'call-reviews');
    storagePath = saved.storagePath;
    mimeType = saved.mimeType;
  }

  await prisma.callReview.create({
    data: {
      organizationId: actor.organizationId,
      agentId,
      supervisorId: actor.id,
      storagePath,
      mimeType,
      feedback: req.body.feedback || undefined,
    },
  });

  await createNotification({
    profileId: agentId,
    type: 'call_review.added',
    title: 'New call review',
    body: 'Your supervisor added feedback on one of your calls.',
    link: '/call-reviews',
  });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'call_review.created' });

  res.redirect('/call-reviews');
});

router.get('/call-reviews/:id/recording', requireRole('ADMIN', 'SUPERVISOR'), async (req, res) => {
  const fs = require('fs');
  const { resolveStoragePath } = require('../lib/storage');
  const review = await prisma.callReview.findUnique({ where: { id: req.params.id } });
  if (!review || !review.storagePath) return res.status(404).send('Not found');
  if (req.profile.role === 'SUPERVISOR' && review.supervisorId !== req.profile.id) {
    return res.status(403).send('Forbidden');
  }
  const filePath = resolveStoragePath(review.storagePath);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', review.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', req.profile.role === 'ADMIN' ? 'attachment' : 'inline');
  // sendFile supports Range requests (seeking / resuming a recording) and sends Content-Length.
  res.sendFile(filePath, { cacheControl: false, dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.status(err.status || 500).send('Not available');
  });
});

module.exports = router;
