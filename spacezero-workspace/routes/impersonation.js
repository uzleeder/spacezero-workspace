'use strict';

const express = require('express');
const router = express.Router();

const { requireSession } = require('../lib/authMiddleware');
const { endImpersonation } = require('../lib/impersonation');
const { safeRedirect } = require('../lib/requestSecurity');

router.post('/end-impersonation', requireSession, async (req, res) => {
  await endImpersonation(req, res);
  res.redirect(req.body && req.body.next ? safeRedirect(req.body.next) : '/dashboard'); // optional same-site landing page, e.g. the Setup page being managed
});

module.exports = router;
