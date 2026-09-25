'use strict';

const { getSessionProfile } = require('./session');

// Runs on every request: loads the current profile (if any) onto
// req.profile and res.locals.profile so views can read it. This is the
// ONLY place the session cookie is trusted from — every subsequent check
// re-reads req.profile, never the raw cookie.
async function attachProfile(req, res, next) {
  try {
    req.profile = await getSessionProfile(req);
    res.locals.profile = req.profile;
  } catch {
    req.profile = null;
  }
  next();
}

// Secure check for any protected page or mutating route. Never rely on
// client-side checks alone — this runs server-side on every request.
function requireSession(req, res, next) {
  if (!req.profile) {
    const nextUrl = encodeURIComponent(req.originalUrl || '/dashboard');
    return res.redirect(`/login?next=${nextUrl}`);
  }
  next();
}

function requireRole(...roles) {
  return function (req, res, next) {
    if (!req.profile) {
      const nextUrl = encodeURIComponent(req.originalUrl || '/dashboard');
      return res.redirect(`/login?next=${nextUrl}`);
    }
    if (!roles.includes(req.profile.role)) {
      return res.status(403).render('forbidden');
    }
    next();
  };
}

const requireAdmin = requireRole('ADMIN');

module.exports = { attachProfile, requireSession, requireRole, requireAdmin };
