'use strict';

function requestSecurity(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'");
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    const expected = process.env.APP_ORIGIN || 'http://localhost:3000';
    // Browsers can submit a normal form with an opaque `null` origin when the
    // page was opened from a sandboxed/opaque context. Permit that only in the
    // temporary development deployment; production must provide a real origin.
    const sameOriginOpaque = origin === 'null' && (process.env.NODE_ENV !== 'production' || req.get('sec-fetch-site') === 'same-origin');
    const originMatches = origin === expected;
    const crossSite = req.get('sec-fetch-site') === 'cross-site' && !originMatches;
    if (crossSite || (origin && !originMatches && !sameOriginOpaque) || (process.env.NODE_ENV === 'production' && !origin && req.get('sec-fetch-site') !== 'same-origin')) {
      return res.status(403).send('Cross-origin request rejected.');
    }
  }
  next();
}

function safeRedirect(value) {
  return typeof value === 'string' && /^\/(?!\/)/.test(value) && !/[\\\r\n]/.test(value)
    ? value : '/dashboard';
}

module.exports = { requestSecurity, safeRedirect };
