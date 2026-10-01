'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const cookieParser = require('cookie-parser');

const { attachProfile } = require('./lib/authMiddleware');
const { roleLabel } = require('./lib/roles');
const { navForRole, LOGIN_AS_ROLES } = require('./lib/nav');
const { hasSystemConfigAccess, ensureInitialSystemConfigAccess } = require('./lib/supervisorCapabilities');
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
app.use(require('./lib/requestSecurity').requestSecurity);

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
app.use('/static/uploads', express.static(require('./lib/uploadRoot').UPLOAD_ROOT, { dotfiles: 'deny', fallthrough: false, cacheControl: false }));
app.use('/static', express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));
app.use(attachImpersonation);
app.use(require('./lib/objectAccess').objectAccess);

// Available to every view without passing it explicitly each time.
app.use(async (req, res, next) => {
  res.locals.profile = req.profile;
  res.locals.roleLabel = roleLabel;
  res.locals.renderInline = renderInline;
  res.locals.nav = req.profile ? navForRole(req.profile.role) : [];
  res.locals.tabsets = req.profile ? require('./lib/navTabs').tabsetsFor(req.profile.role) : {};
  // Settings → Advanced (routes/admin/settings.js) needs a per-Admin capability check, not just a
  // role check — cheap query, Admin requests only. Computed once here so any view can read it.
  if (req.profile && req.profile.role === 'ADMIN') {
    await ensureInitialSystemConfigAccess(req.profile.organizationId);
    res.locals.hasSystemConfigAccess = await hasSystemConfigAccess(req.profile);
  } else {
    res.locals.hasSystemConfigAccess = false;
  }
  res.locals.loginAsRoles = LOGIN_AS_ROLES;
  res.locals.impersonation = req.impersonation || null;
  res.locals.currentPath = req.path;
  res.locals.unreadNotifications = req.profile ? await unreadCount(req.profile.id) : 0;
  res.locals.notificationPreview = req.profile ? await recentPreview(req.profile.id) : [];
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
