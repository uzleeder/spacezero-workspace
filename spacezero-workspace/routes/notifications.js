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

// Opened from the bell dropdown: marks just this one notification read (never the whole list)
// and sends the viewer straight to its destination, falling back to the full page.
router.get('/notifications/:id/open', requireSession, async (req, res) => {
  const n = await prisma.notification.findUnique({ where: { id: req.params.id } });
  if (!n || n.profileId !== req.profile.id) return res.redirect('/notifications');
  if (!n.readAt) await prisma.notification.update({ where: { id: n.id }, data: { readAt: new Date() } });
  res.redirect(n.link || '/notifications');
});

module.exports = router;
