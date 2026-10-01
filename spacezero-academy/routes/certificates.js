'use strict';

const express = require('express');
const router = express.Router();

const { prisma } = require('../lib/prisma');
const { requireSession } = require('../lib/authMiddleware');
const { canViewProfile } = require('../lib/authz');

const SIGNER_NAME = 'Joe Godwin';
const SIGNER_TITLE = 'Head of Training · SpaceZero Workspace';

router.get('/certificates/:id', requireSession, async (req, res) => {
  const cert = await prisma.certificate.findUnique({
    where: { id: req.params.id },
    include: { profile: true },
  });
  if (!cert || cert.profile.organizationId !== req.profile.organizationId) {
    return res.status(404).render('not-found', { layout: false });
  }
  const allowed = await canViewProfile(req.profile, cert.profileId);
  if (!allowed) return res.status(403).render('forbidden');

  const course = cert.courseId ? await prisma.trainingCourse.findUnique({ where: { id: cert.courseId } }) : null;

  const priorCount = await prisma.certificate.count({
    where: {
      profile: { organizationId: cert.profile.organizationId },
      issuedAt: { lte: cert.issuedAt },
    },
  });
  const certificateNumber = `SZ-${String(priorCount).padStart(4, '0')}-${cert.issuedAt.getFullYear()}`;

  const programLabel =
    course && course.roleKey === 'TRAVEL_AGENT'
      ? 'Premium Travel · Sales Training Program'
      : course && course.roleKey === 'FLIGHT_EXPERT'
      ? 'Premium Travel · Technical Training Program'
      : 'Professional Development Program';

  res.render('certificate', {
    layout: false,
    title: 'Certificate',
    cert,
    course,
    certificateNumber,
    programLabel,
    signerName: SIGNER_NAME,
    signerTitle: SIGNER_TITLE,
  });
});

module.exports = router;
