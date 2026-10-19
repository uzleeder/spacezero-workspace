'use strict';
const { prisma } = require('./prisma');
const { canViewProfile } = require('./authz');
async function privateUploads(req, res, next) {
  if (!req.path.startsWith('/static/uploads/')) return next();
  const actor = req.profile;
  if (!actor || !/\.(png|jpg|jpeg|webp)$/i.test(req.path)) return res.status(404).send('Not found');
  let allowed = false;
  if (req.path.startsWith('/static/uploads/avatars/')) {
    const owner = await prisma.profile.findFirst({ where: { photoUrl: req.path, organizationId: actor.organizationId } });
    allowed = owner && await canViewProfile(actor, owner.id);
  } else if (req.path.startsWith('/static/uploads/course-thumbnails/')) {
    const course = await prisma.trainingCourse.findFirst({ where: { thumbnailUrl: req.path, organizationId: actor.organizationId, archivedAt: null,
      ...(actor.role === 'ADMIN' ? {} : { OR: [ ...(actor.role === 'SUPERVISOR' ? [{ createdById: actor.id }] : []), { assignments: { some: { recipients: { some: { profileId: actor.id } } } } } ] }),
    } });
    allowed = Boolean(course);
  }
  if (!allowed) return res.status(404).send('Not found');
  next();
}
module.exports = { privateUploads };
