'use strict';

const express = require('express');
const router = express.Router();

const { requireSession } = require('../lib/authMiddleware');
const { endImpersonation } = require('../lib/impersonation');

router.post('/end-impersonation', requireSession, async (req, res) => {
  await endImpersonation(req, res);
  res.redirect('/dashboard');
});

module.exports = router;
