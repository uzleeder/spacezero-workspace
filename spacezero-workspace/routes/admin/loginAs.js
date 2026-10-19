'use strict';

const express = require('express');
const router = express.Router();

const { prisma } = require('../../lib/prisma');
const { requireAdmin } = require('../../lib/authMiddleware');
const { startImpersonation } = require('../../lib/impersonation');
const { loginAsScope } = require('../../lib/loginAsScope');

const VALID_ROLES = ['ADMIN', 'SUPERVISOR', 'TRAVEL_AGENT', 'FLIGHT_EXPERT'];

router.get('/login-as', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const role = VALID_ROLES.includes(req.query.role) ? req.query.role : 'SUPERVISOR';

  const profiles =
    role === 'ADMIN'
      ? []
      : await prisma.profile.findMany({
          where: { ...loginAsScope(admin), role, testOwnerAdminId: null },
          orderBy: { fullName: 'asc' },
        });

  res.render('admin/login-as', { title: 'Login as', role, profiles, VALID_ROLES });
});

router.post('/login-as/:profileId', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const target = await prisma.profile.findFirst({
    where: { ...loginAsScope(admin), id: req.params.profileId },
  });
  if (!target || target.role === 'ADMIN') {
    return res.status(404).render('error', { layout: false, message: 'That account cannot be viewed as.' });
  }

  await startImpersonation(req, res, target);
  res.redirect('/dashboard');
});

module.exports = router;
