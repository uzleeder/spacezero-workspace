'use strict';

const express = require('express');
const router = express.Router();
const { safeRedirect } = require('../lib/requestSecurity');

const { THEME_COOKIE } = require('../lib/theme');

// No auth required — the theme preference isn't sensitive, and this needs
// to work from the (public) login page too.
router.post('/theme', (req, res) => {
  const next = req.body.theme === 'dark' ? 'dark' : 'light';
  res.cookie(THEME_COOKIE, next, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 365,
    path: '/',
  });
  // The page script switches the theme in place and only needs to know it was saved.
  if (req.get('x-requested-with') === 'fetch') return res.status(204).end();
  // Without script: back to the page the button was on. The site sends Referrer-Policy: no-referrer, so
  // the browser does not tell us - the form carries the page in a hidden "next" field (same-site paths only).
  res.redirect(safeRedirect(req.body.next));
});

module.exports = { router, THEME_COOKIE };
