'use strict';

// Office Management (lib/office.js): only the office manager (Fred Marco) reaches these pages. Anyone else - Admins
// included, and an Admin viewing as Fred - gets "Not found", as if the page did not exist.
const router = require('express').Router();
const { requireSession } = require('../lib/authMiddleware');
const { logAudit } = require('../lib/audit');
const office = require('../lib/office');
const desks = require('../lib/officeDesks');

function onlyOfficeManager(req, res, next) {
  if (!office.canManageOffice(req)) return res.status(404).render('not-found', { layout: false });
  next();
}
const back = (res, notice, error) => res.redirect('/office' + (notice ? '?notice=' + encodeURIComponent(notice) : error ? '?error=' + encodeURIComponent(error) : ''));

router.get('/office', requireSession, onlyOfficeManager, async (req, res) => {
  const filters = { q: String(req.query.q || ''), type: String(req.query.type || ''), holder: String(req.query.holder || ''), condition: String(req.query.condition || ''), product: String(req.query.product || '').slice(0, 120) };
  const [items, totals, people, deskGroups] = await Promise.all([office.listItems(req.profile, filters), office.summary(req.profile), office.people(req.profile), desks.desksByTeam(req.profile)]);
  res.set('Cache-Control', 'private, no-store');
  res.render('office/index', {
    title: 'Office Management', items, totals, people, filters, deskGroups,
    TYPES: office.TYPES, CONDITIONS: office.CONDITIONS, maxAtOnce: office.MAX_AT_ONCE,
    notice: String(req.query.notice || '').slice(0, 200), error: String(req.query.error || '').slice(0, 200),
  });
});

router.post('/office/items', requireSession, onlyOfficeManager, async (req, res) => {
  const out = await office.addItems(req.profile, req.body);
  if (out.error) return back(res, null, out.error);
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'office.items_added', targetTable: 'OfficeItem', metadata: { name: out.name, count: out.added } });
  back(res, out.added === 1 ? `Added: ${out.name}.` : `Added ${out.added} × ${out.name}.`);
});

router.post('/office/items/:id', requireSession, onlyOfficeManager, async (req, res) => {
  const out = await office.updateItem(req.profile, req.params.id, req.body);
  if (out.status === 404) return res.status(404).render('not-found', { layout: false });
  if (out.error) return back(res, null, out.error);
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'office.item_updated', targetTable: 'OfficeItem', targetId: req.params.id, metadata: { name: out.name } });
  back(res, `Saved: ${out.name}.`);
});

router.post('/office/items/:id/delete', requireSession, onlyOfficeManager, async (req, res) => {
  if (!(await office.deleteItem(req.profile, req.params.id))) return res.status(404).render('not-found', { layout: false });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'office.item_deleted', targetTable: 'OfficeItem', targetId: req.params.id });
  back(res, 'Item removed.');
});

// ---- Desks by team: number, person, what is on the desk, the computer password (encrypted), note ----
router.post('/office/desks', requireSession, onlyOfficeManager, async (req, res) => {
  const out = await desks.saveDesk(req.profile, null, req.body);
  if (out.error) return back(res, null, out.error);
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'office.desk_added', targetTable: 'OfficeDesk', targetId: out.desk.id, metadata: { number: out.desk.number } });
  back(res, `Desk ${out.desk.number} added.`);
});

router.post('/office/desks/:id', requireSession, onlyOfficeManager, async (req, res) => {
  const out = await desks.saveDesk(req.profile, req.params.id, req.body);
  if (out.status === 404) return res.status(404).render('not-found', { layout: false });
  if (out.error) return back(res, null, out.error);
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'office.desk_updated', targetTable: 'OfficeDesk', targetId: out.desk.id, metadata: { number: out.desk.number, passwordChanged: Boolean(req.body.password) || req.body.clearPassword === '1' } });
  back(res, `Desk ${out.desk.number} saved.`);
});

router.post('/office/desks/:id/delete', requireSession, onlyOfficeManager, async (req, res) => {
  if (!(await desks.deleteDesk(req.profile, req.params.id))) return res.status(404).render('not-found', { layout: false });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'office.desk_deleted', targetTable: 'OfficeDesk', targetId: req.params.id });
  back(res, 'Desk removed.');
});

// "My PC" on a person's own Setup page: their own computer's password, on request. Never for anyone else's desk.
router.post('/my/desk/password', requireSession, async (req, res) => {
  if (req.impersonation) return res.status(404).json({ error: 'Not found' });
  const out = await desks.ownPassword(req.profile.id);
  if (!out) return res.status(404).json({ error: 'Not found' });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'office.own_desk_password_viewed', targetTable: 'OfficeDesk', targetId: out.desk.id, metadata: { number: out.desk.number } });
  res.set('Cache-Control', 'no-store');
  res.json({ password: out.password });
});

// "Show" on a computer password: the only way a password leaves the database. Never cached; always in the audit log.
router.post('/office/desks/:id/password', requireSession, onlyOfficeManager, async (req, res) => {
  const out = await desks.revealPassword(req.profile, req.params.id);
  if (out.status === 404) return res.status(404).json({ error: 'Not found' });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'office.desk_password_viewed', targetTable: 'OfficeDesk', targetId: out.desk.id, metadata: { number: out.desk.number } });
  res.set('Cache-Control', 'no-store');
  res.json({ password: out.password });
});

module.exports = router;
