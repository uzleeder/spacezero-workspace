'use strict';

// Office Management (lib/office.js): only the office manager (Fred Marco) reaches these pages. Anyone else - Admins
// included, and an Admin viewing as Fred - gets "Not found", as if the page did not exist.
const router = require('express').Router();
const { requireSession } = require('../lib/authMiddleware');
const { logAudit } = require('../lib/audit');
const office = require('../lib/office');

function onlyOfficeManager(req, res, next) {
  if (!office.canManageOffice(req)) return res.status(404).render('not-found', { layout: false });
  next();
}
const back = (res, notice, error) => res.redirect('/office' + (notice ? '?notice=' + encodeURIComponent(notice) : error ? '?error=' + encodeURIComponent(error) : ''));

router.get('/office', requireSession, onlyOfficeManager, async (req, res) => {
  const filters = { q: String(req.query.q || ''), type: String(req.query.type || ''), holder: String(req.query.holder || ''), condition: String(req.query.condition || '') };
  const [items, totals, people] = await Promise.all([office.listItems(req.profile, filters), office.summary(req.profile), office.people(req.profile)]);
  res.set('Cache-Control', 'private, no-store');
  res.render('office/index', {
    title: 'Office Management', items, totals, people, filters,
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

module.exports = router;
