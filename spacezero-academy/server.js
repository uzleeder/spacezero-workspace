'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const cookieParser = require('cookie-parser');

const { attachProfile } = require('./lib/authMiddleware');
const { roleLabel } = require('./lib/roles');
const { navForRole, LOGIN_AS_ROLES } = require('./lib/nav');
const { hasSystemConfigAccess, ensureInitialSystemConfigAccess, capabilitiesFor } = require('./lib/supervisorCapabilities');
const { unreadCount, recentPreview, formatRelativeTime } = require('./lib/notifications');
const { attachImpersonation } = require('./lib/impersonation');
const { router: themeRouter, THEME_COOKIE } = require('./routes/theme');
const { renderInline } = require('./lib/richContent');
const { prisma } = require('./lib/prisma');

const app = express();
if (process.env.NODE_ENV === 'production') require('./lib/productionConfig').validateProductionConfig();
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;

// Lets a tunnel (ngrok etc.) or a reverse proxy forward the real client IP
// for rate limiting / audit logging.
app.set('trust proxy', false);
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
// Compress text responses (HTML, CSS, JS, JSON). The reverse proxy only compresses HTML by default,
// so stylesheets and scripts were being sent raw.
app.use(require('compression')());
app.use(require('./lib/requestSecurity').requestSecurity);

// The app's own CSS/JS/images are served BEFORE the session lookup, body parsers and per-request
// view data: they need none of it, and each used to cost a database round trip. URLs built with
// asset() carry a content hash, so they are cached for a year (immutable); anything requested without
// the hash is cached briefly. Private uploads (/static/uploads) stay behind the session check below.
const publicStatic = express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',
  cacheControl: false,
  etag: true,
  // Only called for a file that really is being sent, so a missing file's 404 is never cached.
  setHeaders: (res) => res.setHeader('Cache-Control', res.req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'),
});
app.use('/static', (req, res, next) => (/^\/uploads(\/|$)/.test(req.path) ? next() : publicStatic(req, res, next)));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// not-found/forbidden/error are complete standalone documents (their own <html>/<head>/<body>),
// never the sidebar shell — dozens of call sites across the app render them as
// res.render('forbidden') with no options object, so layout:false is enforced here once, globally,
// rather than requiring every call site to remember it (a missed one silently nests a second full
// HTML document inside layout.ejs's <body>).
const STANDALONE_VIEWS = new Set(['not-found', 'forbidden', 'error']);
app.use((req, res, next) => {
  res.locals.asset = require('./lib/assets').asset; // content-hashed /static/css|js URLs, available to every view (also error pages)
  const render = res.render.bind(res);
  res.render = (view, options, callback) => {
    if (STANDALONE_VIEWS.has(view)) return render(view, { ...options, layout: false }, callback);
    return render(view, options, callback);
  };
  next();
});

app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(require('./lib/sensitiveRateLimit').sensitiveRateLimit);

app.use(attachProfile);
app.use(require('./lib/privateUploads').privateUploads);
app.use('/static/uploads', express.static(require('./lib/uploadRoot').UPLOAD_ROOT, { dotfiles: 'deny', fallthrough: false, cacheControl: false, setHeaders: (res) => res.setHeader('Cache-Control', 'private, max-age=600') })); // avatars/thumbnails: the viewer's own browser may reuse them for a few minutes (each fetch costs an authorization query)
app.use(attachImpersonation);
app.use(require('./lib/objectAccess').objectAccess);

// The one-time "initial System Configuration Access" seeding only needs to be attempted once per
// organization per process, not on every Admin request.
const configAccessSeeded = new Set();
async function seedThenCheckConfigAccess(admin) {
  if (!configAccessSeeded.has(admin.organizationId)) {
    await ensureInitialSystemConfigAccess(admin.organizationId);
    configAccessSeeded.add(admin.organizationId);
  }
  return hasSystemConfigAccess(admin);
}

// Available to every view without passing it explicitly each time.
app.use(async (req, res, next) => {
  res.locals.profile = req.profile;
  res.locals.roleLabel = roleLabel;
  res.locals.renderInline = renderInline;
  res.locals.nav = req.profile ? navForRole(req.profile.role) : [];
  // can(key): may THIS viewer use a Supervisor-grantable capability (lib/supervisorCapabilities.js).
  // Admins always may; a Supervisor only with an explicit grant; everyone else never. Views use it to
  // not offer a link/button the server would answer with "Access denied" — the server-side check on
  // every route stays the real gate, this only stops dead ends from being shown.
  // The four lookups below are independent, so they run together (one database round trip's worth of
  // waiting instead of four in a row — on every single page view).
  const person = req.profile;
  const [grants, hasConfigAccess, unread, preview] = await Promise.all([
    person && person.role === 'SUPERVISOR' ? capabilitiesFor(person.id) : null,
    // Settings → Advanced (routes/admin/settings.js) needs a per-Admin capability check, not just a
    // role check. Computed once here so any view can read it.
    person && person.role === 'ADMIN' ? seedThenCheckConfigAccess(person) : false,
    person ? unreadCount(person.id) : 0,
    person ? recentPreview(person.id) : [],
  ]);
  res.locals.can = (key) => Boolean(req.profile) && (req.profile.role === 'ADMIN' || Boolean(grants && grants.has(key)));
  res.locals.tabsets = req.profile ? require('./lib/navTabs').tabsetsFor(req.profile.role, res.locals.can) : {};
  res.locals.hasSystemConfigAccess = Boolean(hasConfigAccess);
  res.locals.loginAsRoles = LOGIN_AS_ROLES;
  res.locals.impersonation = req.impersonation || null;
  res.locals.currentPath = req.path;
  res.locals.unreadNotifications = unread;
  res.locals.notificationPreview = preview;
  res.locals.formatRelativeTime = formatRelativeTime;
  res.locals.theme = req.cookies[THEME_COOKIE] === 'dark' ? 'dark' : 'light';
  next();
});

app.get('/', (req, res) => {
  res.redirect(req.profile ? '/dashboard' : '/login');
});

app.use('/', themeRouter);
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/dashboard'));
app.use('/', require('./routes/profile'));
app.use('/', require('./routes/skillDna'));
app.use('/', require('./routes/agent'));
app.use('/', require('./routes/notes'));
app.use('/', require('./routes/practice'));
app.use('/', require('./routes/employeeRecord'));
app.use('/', require('./routes/credentials'));
app.use('/', require('./routes/leave'));
app.use('/', require('./routes/trainingContent'));
app.use('/', require('./routes/library'));
app.use('/', require('./routes/teamIntel'));
app.use('/', require('./routes/recommendations'));
app.use('/', require('./routes/team'));
app.use('/', require('./routes/assignments'));
app.use('/', require('./routes/skills'));
app.use('/', require('./routes/notifications'));
app.use('/', require('./routes/certificates'));
app.use('/', require('./routes/impersonation'));
app.use('/', require('./routes/legacyRedirects'));
app.use('/', require('./routes/aiPractice'));
app.use('/', require('./routes/callIntelligence'));
app.use('/', require('./routes/standards'));
app.use('/', require('./routes/spacezeroAI'));
app.use('/admin', require('./routes/admin/employees'));
app.use('/admin', require('./routes/admin/teams'));
app.use('/admin', require('./routes/admin/training'));
app.use('/admin', require('./routes/admin/library'));
app.use('/admin', require('./routes/admin/settings'));
app.use('/admin', require('./routes/admin/setupSettings'));
app.use('/admin', require('./routes/admin/misc'));
app.use('/admin', require('./routes/admin/loginAs'));
app.use('/admin', require('./routes/admin/assessments'));
app.use('/admin', require('./routes/admin/orgIntel'));
app.use('/admin', require('./routes/admin/development'));
app.use('/admin', require('./routes/admin/standards'));
app.use('/admin', require('./routes/admin/supervisorPermissions'));
app.use('/admin', require('./routes/admin/configuration'));

if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  // Every background job type must be registered at boot, or queued work would wait for the first request that happens to load it.
  for (const lib of ['callRetention', 'trainingAnalysis', 'callIntelligence', 'aiTasks', 'automation']) require(`./lib/${lib}`);
  require('./lib/jobQueue').start();
}

app.use((req, res) => {
  res.status(404).render('not-found', { layout: false });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { layout: false, message: 'Something went wrong. Please try again.' });
});

if (require.main === module) {
  // Prisma's query engine connects lazily on its first query by default, so without this the
  // very first page a person opens after every boot/restart pays a one-off ~2s connection cost
  // (felt constantly in dev, where --watch restarts the process on every file save). Connecting
  // here, before the port opens, moves that cost to boot time instead of a real request.
  prisma.$connect()
    .then(() => {
      const configuredHost = process.env.HOST;
      if (configuredHost) {
        // Explicit host (e.g. production's HOST=0.0.0.0) — bind exactly as configured, unchanged.
        app.listen(PORT, configuredHost, () => {
          console.log(`SpaceZero Workspace running at http://${configuredHost}:${PORT}`);
        });
        return;
      }
      // Local dev default: listen on BOTH loopback addresses (still never reachable off this
      // machine). Resolving "localhost" on Windows often tries the IPv6 loopback (::1) first;
      // with nothing listening there, that attempt has to time out (~2s) before falling back to
      // IPv4 — felt as "every page loads slowly". Binding both means whichever address a browser
      // or tool tries first connects immediately, so that fallback delay never happens.
      http.createServer(app).listen(PORT, '127.0.0.1');
      http.createServer(app).listen(PORT, '::1', () => {
        console.log(`SpaceZero Workspace running at http://localhost:${PORT}`);
      });
    })
    .catch((err) => {
      console.error('Failed to connect to the database:', err);
      process.exit(1);
    });
}
module.exports = app;
