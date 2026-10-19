'use strict';

// Acting on a development recommendation: assign it or dismiss it. A recommendation never does
// anything by itself. An Admin may act on anyone in the organization, a Supervisor only on their own
// team — decided here from the database, not from the request.
const router = require('express').Router();
const { prisma } = require('../lib/prisma');
const { requireRole } = require('../lib/authMiddleware');
const { supervisedProfileIds } = require('../lib/authz');
const { excludeOtherAdminsTestProfiles } = require('../lib/loginAsScope');
const { bulkAssign, BulkError } = require('../lib/bulkAssign');
const { logAudit } = require('../lib/audit');

const manage = requireRole('ADMIN', 'SUPERVISOR');
const notFound = (res) => res.status(404).render('not-found', { layout: false });

async function loadFor(actor, id) {
  const rec = await prisma.developmentRecommendation.findFirst({ where: { id, organizationId: actor.organizationId, status: 'OPEN' } });
  if (!rec) return null;
  if (actor.role === 'SUPERVISOR') return (await supervisedProfileIds(actor.id)).includes(rec.profileId) ? rec : null;
  const person = await prisma.profile.findFirst({ where: { id: rec.profileId, organizationId: actor.organizationId, ...excludeOtherAdminsTestProfiles(actor) }, select: { id: true } });
  return person ? rec : null;
}

const backTo = (req) => (req.body.returnTo === 'team' ? '/team-skills' : '/admin/development');

router.post('/recommendations/:id/assign', manage, async (req, res) => {
  const actor = req.profile;
  const rec = await loadFor(actor, req.params.id);
  if (!rec) return notFound(res); // another team's / organization's recommendation looks like it does not exist
  if (!rec.courseId) return res.redirect(`${backTo(req)}?error=${encodeURIComponent('This recommendation has no training to assign.')}`);
  try {
    await bulkAssign(actor, [rec.profileId], { kind: rec.assessmentId ? 'PRACTICE' : 'COURSE', employeeIds: [rec.profileId], courseId: rec.courseId, assessmentId: rec.assessmentId, note: `Recommended: ${rec.reason}`.slice(0, 500) });
  } catch (err) {
    if (err instanceof BulkError) return res.redirect(`${backTo(req)}?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
  await prisma.developmentRecommendation.update({ where: { id: rec.id }, data: { status: 'ASSIGNED', resolvedAt: new Date(), resolvedById: actor.id } });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'development.recommendation_assigned', targetTable: 'DevelopmentRecommendation', targetId: rec.id, metadata: { employeeId: rec.profileId } });
  res.redirect(backTo(req));
});

router.post('/recommendations/:id/dismiss', manage, async (req, res) => {
  const actor = req.profile;
  const rec = await loadFor(actor, req.params.id);
  if (!rec) return notFound(res);
  await prisma.developmentRecommendation.update({ where: { id: rec.id }, data: { status: 'DISMISSED', resolvedAt: new Date(), resolvedById: actor.id } });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'development.recommendation_dismissed', targetTable: 'DevelopmentRecommendation', targetId: rec.id, metadata: { employeeId: rec.profileId } });
  res.redirect(backTo(req));
});

module.exports = router;
