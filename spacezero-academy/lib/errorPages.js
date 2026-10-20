'use strict';

// One place that decides how a refused or failed request looks to a PERSON.
//
// Before: some routes answered a browser with a bare line of text ("Not found", "Forbidden", "Invalid team" ...) on a
// white page, a few showed a clear reason under the headline "Something went wrong", and the only way out was
// "Back to dashboard". Now every refusal that a browser navigation receives is the branded page, with a headline that
// fits the situation (not found / no access / can't be done right now / too many attempts ...), the real reason, a
// "Go back" button to the page the person came from, and - where one is known - a button for the obvious next step.
// Requests that are not page navigations (fetch/JSON, images, files) keep their plain answers.
const crypto = require('node:crypto');
const { themeFor } = require('./theme');

const HEADINGS = {
  400: "That didn't work",
  401: 'Please sign in',
  403: 'Access denied',
  404: 'Page not found',
  409: "This can't be done right now",
  413: 'That file is too large',
  429: 'Too many attempts',
  503: 'Temporarily unavailable',
};
const headingFor = (status) => HEADINGS[status] || (status >= 500 ? 'Something went wrong' : "That didn't work");

// The bare words routes have always sent; they get the standard 404 / 403 pages rather than a custom card.
const BARE = { 404: /^not found\.?$/i, 403: /^forbidden\.?$/i };

const wantsPage = (req) => /text\/html/i.test(req.get('accept') || '');
// fetch()/XHR callers that asked for JSON get JSON; everyone else (browsers, plain clients) gets the page
const wantsJson = (req) => /application\/json/i.test(req.get('accept') || '') && !wantsPage(req);

/** The page the person came from, as a same-site path (never the failing URL itself, never another site). */
function backUrl(req) {
  try {
    const referer = req.get('referer');
    if (!referer) return null;
    const url = new URL(referer);
    if (url.host !== req.get('host')) return null;
    const path = url.pathname + url.search;
    if (path === req.originalUrl || /^\/(login|logout)\b/.test(url.pathname)) return null;
    return path;
  } catch { return null; }
}

/** Renders the right error page for `status` (a browser navigation). `message` is the reason shown to the person. */
function renderErrorPage(req, res, status, message, extra = {}) {
  const back = backUrl(req);
  // Some refusals happen early (before the page-wide view settings exist), so this page must not depend on them.
  const theme = res.locals.theme || themeFor(req);
  const locals = { layout: false, backUrl: back, theme, ...extra };
  res.status(status);
  if (status === 404 && (!message || BARE[404].test(message))) return res.render('not-found', locals);
  if (status === 403 && (!message || BARE[403].test(message))) return res.render('forbidden', locals);
  return res.render('error', { ...locals, message });
}

/**
 * Express middleware, installed before the routes:
 *  - res.send(<plain text>) with a 4xx/5xx status on a browser navigation becomes the branded page;
 *  - res.render('error') gets the headline that matches its status code unless the route chose one.
 */
function friendlyErrors(req, res, next) {
  const send = res.send;
  const render = res.render;
  res.send = function (body) {
    const status = this.statusCode;
    if (status >= 400 && typeof body === 'string' && body.length < 500 && !/[<>]/.test(body) && wantsPage(req) && !this.headersSent && !this.locals.__friendlyError) {
      this.locals.__friendlyError = true;
      return renderErrorPage(req, this, status, body);
    }
    return send.call(this, body);
  };
  res.render = function (view, options, callback) {
    if (view === 'error' && options && typeof options === 'object' && !Array.isArray(options)) {
      options = { heading: headingFor(this.statusCode), backUrl: backUrl(req), theme: this.locals.theme || themeFor(req), ...options };
    }
    return render.call(this, view, options, callback);
  };
  next();
}

/** The last-resort handler: unexpected errors get a reference number (also in the server log) so they can be traced. */
function handleError(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = Number(err && (err.status || err.statusCode));
  if (status === 404 || (err && err.code === 'ENOENT')) {
    if (req.path.startsWith('/static/')) return res.status(404).end();
    return wantsJson(req) ? res.status(404).json({ error: 'Not found' }) : renderErrorPage(req, res, 404, '');
  }
  if (status >= 400 && status < 500) {
    const message = status === 413 ? 'That upload is too large. Choose a smaller file and try again.' : 'That request could not be understood. Please go back and try again.';
    if (req.path.startsWith('/static/')) return res.status(status).end();
    return wantsJson(req) ? res.status(status).json({ error: message }) : renderErrorPage(req, res, status, message);
  }
  const reference = crypto.randomBytes(4).toString('hex');
  console.error(`[${reference}]`, err);
  if (wantsJson(req)) return res.status(500).json({ error: 'Something went wrong.', reference });
  return renderErrorPage(req, res, 500, 'Something went wrong on our side. Please try again in a moment. If it keeps happening, tell your administrator and quote the reference below.', { reference });
}

/** Unmatched URL. */
function handleNotFound(req, res) {
  if (req.path.startsWith('/static/')) return res.status(404).end();
  if (wantsJson(req)) return res.status(404).json({ error: 'Not found' });
  return renderErrorPage(req, res, 404, '');
}

module.exports = { headingFor, backUrl, renderErrorPage, friendlyErrors, handleError, handleNotFound };
