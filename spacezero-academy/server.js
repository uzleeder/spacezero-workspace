'use strict';

const path = require('path');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const cookieParser = require('cookie-parser');

const { attachProfile } = require('./lib/authMiddleware');
const { roleLabel } = require('./lib/roles');
const { navForRole, LOGIN_AS_ROLES } = require('./lib/nav');
const { unreadCount } = require('./lib/notifications');
const { attachImpersonation } = require('./lib/impersonation');
const { router: themeRouter, THEME_COOKIE } = require('./routes/theme');

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
  res.locals.nav = req.profile ? navForRole(req.profile.role) : [];
  res.locals.tabsets = req.profile ? require('./lib/navTabs').tabsetsFor(req.profile.role) : {};
  res.locals.loginAsRoles = LOGIN_AS_ROLES;
  res.locals.impersonation = req.impersonation || null;
  res.locals.currentPath = req.path;
  res.locals.unreadNotifications = req.profile ? await unreadCount(req.profile.id) : 0;
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

if (require.main === module) app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`SpaceZero Academy running at http://localhost:${PORT}`);
});
module.exports = app;
