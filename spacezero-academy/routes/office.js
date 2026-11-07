'use strict';

// Office Management - Overview, Assets, Desks, Repairs, Activity. Only the office manager reaches any of it: every page,
// change and detail request goes through onlyOfficeManager (Profile.officeManager, not while viewing as someone, and
// only their own organization's records - the lib functions scope every query by organizationId). Anyone else - Admins
// and Supervisors included - gets "Not found", as if the pages did not exist.
//
// Lists keep their state in the address bar (filters, sort, page, rows per page); an opened record is a drawer on top of
// the list (?asset=, ?desk=, ?repair=, ?new=1), so Back/Forward and reloading work. Saving returns to the same list
// position; a refused save shows the form again with what was typed and the reason.
const router = require('express').Router();
const { requireSession } = require('../lib/authMiddleware');
const { logAudit } = require('../lib/audit');
const office = require('../lib/office');
const desks = require('../lib/officeDesks');
const repairs = require('../lib/officeRepairs');
const activity = require('../lib/officeActivity');

function onlyOfficeManager(req, res, next) {
  if (!office.canManageOffice(req)) return res.status(404).render('not-found', { layout: false });
  res.set('Cache-Control', 'private, no-store');
  next();
}
const guard = [requireSession, onlyOfficeManager];
const notFound = (res) => res.status(404).render('not-found', { layout: false });

const TABS = [
  { label: 'Overview', href: '/office' }, { label: 'Assets', href: '/office/assets' }, { label: 'Desks', href: '/office/desks' },
  { label: 'Repairs', href: '/office/repairs' }, { label: 'Activity', href: '/office/activity' },
];
const DRAWER_PARAMS = ['asset', 'new', 'desk', 'repair', 'notice', 'error'];

/** The list the manager came from (path + query), only ever an Office page; drawer and message params removed. */
function backFrom(value, fallback) {
  const raw = String(value || '');
  if (!/^\/office(\/(assets|desks|repairs|activity))?(\?[^#\s]*)?$/.test(raw)) return fallback;
  const url = new URL(raw, 'http://x');
  for (const p of DRAWER_PARAMS) url.searchParams.delete(p);
  return url.pathname + (url.search || '');
}
function go(res, back, { notice, open, anchor } = {}) {
  const url = new URL(back, 'http://x');
  if (notice) url.searchParams.set('notice', notice);
  for (const [k, v] of [].concat(open && typeof open[0] === 'string' ? [open] : open || [])) if (v) url.searchParams.set(k, v);
  res.redirect(url.pathname + url.search + (anchor ? '#' + anchor : ''));
}
const here = (req) => req.originalUrl;
const msg = (req) => ({ notice: String(req.query.notice || '').slice(0, 300), error: String(req.query.error || '').slice(0, 300) });
const common = (req, tab) => ({ title: 'Office Management', tabs: TABS, tab, here: here(req), CATEGORIES: office.CATEGORIES, CONDITIONS: office.CONDITIONS, LIFECYCLES: office.LIFECYCLES, ...msg(req) });

// ---------------------------------------------------------------- Overview
router.get('/office', guard, async (req, res) => {
  const [ov, deskCounts, repairCounts, followUps] = await Promise.all([
    office.overview(req.profile), desks.deskCounts(req.profile), repairs.counts(req.profile),
    repairs.list(req.profile, { view: 'open' }),
  ]);
  const now = new Date();
  res.render('office/overview', {
    ...common(req, 'overview'), ov, VIEWS: office.VIEWS, deskCounts, repairCounts, repairs,
    followUps: followUps.filter((r) => repairs.isOverdue(r, now) || repairs.isDueSoon(r, now) || r.status === 'WAITING').slice(0, 8), now,
  });
});

// ---------------------------------------------------------------- Assets
async function renderAssets(req, res, { status = 200, filtersFrom, drawer = null, values = null, error = '', preview = null } = {}) {
  const query = filtersFrom ? Object.fromEntries(new URL(filtersFrom, 'http://x').searchParams) : req.query;
  const filters = office.readFilters(query);
  const [list, people, deskList, locations] = await Promise.all([office.listAssets(req.profile, filters), office.people(req.profile), office.desks(req.profile), office.locations(req.profile)]);
  let asset = null; let history = []; let assetRepairs = [];
  const assetId = drawer && drawer.assetId ? drawer.assetId : (!drawer && req.query.asset ? String(req.query.asset) : null);
  if (assetId) {
    asset = await office.getAsset(req.profile, assetId);
    if (!asset) return notFound(res);
    [history, assetRepairs] = await Promise.all([
      activity.list(req.profile, { item: asset.id, per: 15 }).then((a) => a.rows),
      require('../lib/prisma').prisma.officeRepair.findMany({ where: { itemId: asset.id, organizationId: req.profile.organizationId }, orderBy: { openedAt: 'desc' }, take: 10 }),
    ]);
  }
  const mode = asset ? 'asset' : (drawer && drawer.mode === 'new') || (!drawer && req.query.new === '1') ? 'new' : null;
  const listUrl = backFrom(filtersFrom || here(req), '/office/assets');
  res.status(status).render('office/assets', {
    ...common(req, 'assets'), ...(error ? { error } : {}), filters, list, people, deskList, locations, mode, rec: asset, history, assetRepairs, values, preview, listUrl,
    VIEWS: office.VIEWS, SORTS: office.SORTS, PAGE_SIZES: office.PAGE_SIZES, MAX_AT_ONCE: office.MAX_AT_ONCE, repairs,
  });
}
router.get('/office/assets', guard, (req, res) => renderAssets(req, res));

router.post('/office/assets', guard, async (req, res) => {
  const back = backFrom(req.body.back, '/office/assets');
  const out = await office.createAssets(req.profile, req.body);
  if (out.error) return renderAssets(req, res, { status: 400, filtersFrom: back, drawer: { mode: 'new' }, values: req.body, error: out.error });
  if (out.preview) return renderAssets(req, res, { filtersFrom: back, drawer: { mode: 'new' }, values: req.body, preview: out.preview });
  const first = out.created[0];
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'office.items_added', targetTable: 'OfficeItem', metadata: { count: out.created.length, from: first.assetTag } });
  const notice = out.created.length === 1 ? `Added ${first.assetTag} ${first.name}.` : `Added ${out.created.length} assets: ${first.assetTag} to ${out.created[out.created.length - 1].assetTag}.`;
  go(res, back, { notice, anchor: 'row-' + first.id });
});

function assetAction(fn, verb) {
  return async (req, res) => {
    const back = backFrom(req.body.back, '/office/assets');
    const out = await fn(req.profile, req.params.id, req.body);
    if (out.status === 404) return notFound(res);
    const deskOpen = req.body.reopenDesk ? ['desk', String(req.body.reopenDesk).slice(0, 40)] : null;
    if (out.error) {
      if (back.startsWith('/office/desks')) return go(res, back, { open: [['error', out.error], deskOpen] });
      return renderAssets(req, res, { status: out.conflict ? 409 : 400, filtersFrom: back, drawer: { assetId: req.params.id }, values: req.body, error: out.error });
    }
    const keepOpen = back.startsWith('/office/assets') ? ['asset', req.params.id] : deskOpen;
    go(res, back, { notice: out.summary || `${verb}.`, open: keepOpen, anchor: back.startsWith('/office/assets') ? 'row-' + req.params.id : '' });
  };
}
router.post('/office/assets/:id', guard, assetAction(office.updateDetails, 'Saved'));
router.post('/office/assets/:id/custody', guard, assetAction(office.changeCustody, 'Saved'));
router.post('/office/assets/:id/retire', guard, assetAction((a, id, b) => office.setRetired(a, id, b, true), 'Retired'));
router.post('/office/assets/:id/restore', guard, assetAction((a, id, b) => office.setRetired(a, id, b, false), 'Restored'));

// ---------------------------------------------------------------- Desks
async function renderDesks(req, res, { status = 200, filtersFrom, deskId, mode, values = null, error = '' } = {}) {
  const query = filtersFrom ? Object.fromEntries(new URL(filtersFrom, 'http://x').searchParams) : req.query;
  const view = desks.VIEWS[query.view] ? query.view : 'all';
  const q = String(query.q || '').slice(0, 80);
  const [list, counts, people, assignable] = await Promise.all([
    desks.listDesks(req.profile, { view, q }), desks.deskCounts(req.profile), office.people(req.profile),
    require('../lib/prisma').prisma.officeItem.findMany({ where: { organizationId: req.profile.organizationId, lifecycle: 'ACTIVE', condition: 'GOOD', holderId: null, deskId: null }, select: { id: true, assetTag: true, name: true, version: true, type: true } }),
  ]);
  assignable.sort((a, b) => office.naturalCompare(a.assetTag, b.assetTag));
  const id = deskId || (!mode && req.query.desk ? String(req.query.desk) : null);
  const desk = id ? await desks.getDesk(req.profile, id) : null;
  if (id && !desk) return notFound(res);
  const drawer = desk ? 'desk' : (mode === 'new' || (!mode && req.query.new === '1')) ? 'new' : null;
  res.status(status).render('office/desks', {
    ...common(req, 'desks'), ...(error ? { error } : {}), view, q, list, counts, people, assignable, desk, drawer, values,
    listUrl: backFrom(filtersFrom || here(req), '/office/desks'), DESK_VIEWS: desks.VIEWS, READY_NEEDS: desks.READY_NEEDS,
  });
}
router.get('/office/desks', guard, (req, res) => renderDesks(req, res));

router.post('/office/desks', guard, async (req, res) => {
  const back = backFrom(req.body.back, '/office/desks');
  const out = await desks.saveDesk(req.profile, null, req.body);
  if (out.error) return renderDesks(req, res, { status: 400, filtersFrom: back, mode: 'new', values: req.body, error: out.error });
  go(res, back, { notice: `Desk ${out.desk.number} added.`, open: ['desk', out.desk.id] });
});
router.post('/office/desks/:id', guard, async (req, res) => {
  const back = backFrom(req.body.back, '/office/desks');
  const out = await desks.saveDesk(req.profile, req.params.id, req.body);
  if (out.status === 404) return notFound(res);
  if (out.error) return renderDesks(req, res, { status: out.conflict ? 409 : 400, filtersFrom: back, deskId: req.params.id, values: req.body, error: out.error });
  if (req.body.password || req.body.clearPassword === '1') await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'office.desk_password_changed', targetTable: 'OfficeDesk', targetId: out.desk.id, metadata: { number: out.desk.number } });
  go(res, back, { notice: `Desk ${out.desk.number} saved.`, open: ['desk', out.desk.id] });
});
router.post('/office/desks/:id/delete', guard, async (req, res) => {
  const back = backFrom(req.body.back, '/office/desks');
  const out = await desks.deleteDesk(req.profile, req.params.id);
  if (out.status === 404) return notFound(res);
  if (out.error) return renderDesks(req, res, { status: 400, filtersFrom: back, deskId: req.params.id, error: out.error });
  go(res, back, { notice: `Desk ${out.removed.number} removed.` });
});

// Links an available asset to this desk (the desk drawer's "Add equipment"): the same custody rules as on the asset.
router.post('/office/desks/:id/link', guard, async (req, res) => {
  const back = backFrom(req.body.back, '/office/desks');
  const [assetId, version] = String(req.body.pick || '').split(':');
  if (!assetId) return go(res, back, { open: [['error', 'Choose an asset to link.'], ['desk', req.params.id]] });
  const out = await office.changeCustody(req.profile, assetId, { mode: 'desk', deskId: req.params.id, version });
  if (out.status === 404) return notFound(res);
  if (out.error) return go(res, back, { open: [['error', out.error], ['desk', req.params.id]] });
  go(res, back, { notice: out.summary, open: ['desk', req.params.id] });
});

// "Show" on a desk's computer password: the only way it leaves the database. Never cached; always in the audit log.
router.post('/office/desks/:id/password', guard, async (req, res) => {
  const out = await desks.revealPassword(req.profile, req.params.id);
  if (out.status === 404) return res.status(404).json({ error: 'Not found' });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'office.desk_password_viewed', targetTable: 'OfficeDesk', targetId: out.desk.id, metadata: { number: out.desk.number } });
  res.json({ password: out.password });
});

// ---------------------------------------------------------------- Repairs
async function renderRepairs(req, res, { status = 200, filtersFrom, repairId, mode, values = null, error = '' } = {}) {
  const query = filtersFrom ? Object.fromEntries(new URL(filtersFrom, 'http://x').searchParams) : req.query;
  const view = repairs.VIEWS[query.view] ? query.view : 'open';
  const q = String(query.q || '').slice(0, 80);
  const [list, counts] = await Promise.all([repairs.list(req.profile, { view, q }), repairs.counts(req.profile)]);
  const id = repairId || (!mode && req.query.repair ? String(req.query.repair) : null);
  const repair = id ? await repairs.get(req.profile, id) : null;
  if (id && !repair) return notFound(res);
  const drawer = repair ? 'repair' : (mode === 'new' || (!mode && req.query.new === '1')) ? 'new' : null;
  let assets = [];
  if (drawer === 'new') {
    assets = await require('../lib/prisma').prisma.officeItem.findMany({ where: { organizationId: req.profile.organizationId, lifecycle: { not: 'RETIRED' } }, select: { id: true, assetTag: true, name: true } });
    assets.sort((a, b) => office.naturalCompare(a.assetTag || a.name, b.assetTag || b.name));
  }
  res.status(status).render('office/repairs', {
    ...common(req, 'repairs'), ...(error ? { error } : {}), view, q, list, counts, repair, drawer, assets, values,
    preselect: String((values && values.itemId) || req.query.asset || ''), listUrl: backFrom(filtersFrom || here(req), '/office/repairs'), repairs, now: new Date(),
  });
}
router.get('/office/repairs', guard, (req, res) => renderRepairs(req, res));

router.post('/office/repairs', guard, async (req, res) => {
  const back = backFrom(req.body.back, '/office/repairs');
  const out = await repairs.open(req.profile, req.body);
  if (out.error) return renderRepairs(req, res, { status: 400, filtersFrom: back, mode: 'new', values: req.body, error: out.error });
  go(res, back.startsWith('/office/repairs') ? back : '/office/repairs', { notice: 'Repair opened.', open: ['repair', out.repair.id] });
});
function repairAction(fn, done) {
  return async (req, res) => {
    const back = backFrom(req.body.back, '/office/repairs');
    const out = await fn(req.profile, req.params.id, req.body);
    if (out.status === 404) return notFound(res);
    if (out.error) return renderRepairs(req, res, { status: out.conflict ? 409 : 400, filtersFrom: back, repairId: req.params.id, values: req.body, error: out.error });
    go(res, back, { notice: done, open: ['repair', req.params.id] });
  };
}
router.post('/office/repairs/:id', guard, repairAction(repairs.update, 'Repair saved.'));
router.post('/office/repairs/:id/resolve', guard, repairAction(repairs.resolve, 'Repair resolved.'));
router.post('/office/repairs/:id/cancel', guard, repairAction(repairs.cancel, 'Repair cancelled.'));
router.post('/office/repairs/:id/reopen', guard, repairAction(repairs.reopen, 'Repair reopened.'));

// ---------------------------------------------------------------- Activity
router.get('/office/activity', guard, async (req, res) => {
  const q = String(req.query.q || '').slice(0, 80);
  const action = activity.ACTIONS[req.query.action] ? String(req.query.action) : '';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const out = await activity.list(req.profile, { q, action, page });
  res.render('office/activity', { ...common(req, 'activity'), q, action, out, ACTIONS: activity.ACTIONS });
});

// ---------------------------------------------------------------- My PC (each person's own Setup page; unchanged rules)
router.post('/my/desk', requireSession, async (req, res) => {
  if (req.impersonation) return notFound(res);
  const out = await desks.saveOwnDesk(req.profile, req.body);
  const to = `/employees/${req.profile.id}/setup`;
  if (out.error) return res.redirect(`${to}?pcError=${encodeURIComponent(out.error)}#my-pc`);
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'office.own_desk_saved', targetTable: 'OfficeDesk', targetId: out.desk.id, metadata: { number: out.desk.number, passwordChanged: Boolean(req.body.password) } });
  res.redirect(`${to}?pc=saved#my-pc`);
});
// Their own computer's password, on request. Never for anyone else's desk.
router.post('/my/desk/password', requireSession, async (req, res) => {
  if (req.impersonation) return res.status(404).json({ error: 'Not found' });
  const out = await desks.ownPassword(req.profile.id);
  if (!out) return res.status(404).json({ error: 'Not found' });
  await logAudit({ organizationId: req.profile.organizationId, actorId: req.profile.id, action: 'office.own_desk_password_viewed', targetTable: 'OfficeDesk', targetId: out.desk.id, metadata: { number: out.desk.number } });
  res.set('Cache-Control', 'no-store');
  res.json({ password: out.password });
});

module.exports = router;
