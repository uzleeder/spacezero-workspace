'use strict';

const express = require('express');
const router = express.Router();

const THEME_COOKIE = 'sz_theme';

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
  res.redirect(req.get('referer') || '/dashboard');
});

module.exports = { router, THEME_COOKIE };
