'use strict';

const express = require('express');
const router = express.Router();

const { prisma } = require('../lib/prisma');
const { requireSession } = require('../lib/authMiddleware');

router.get('/notifications', requireSession, async (req, res) => {
  const notifications = await prisma.notification.findMany({
    where: { profileId: req.profile.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  await prisma.notification.updateMany({
    where: { profileId: req.profile.id, readAt: null },
    data: { readAt: new Date() },
  });
  res.render('notifications', { title: 'Notifications', notifications });
});

module.exports = router;
