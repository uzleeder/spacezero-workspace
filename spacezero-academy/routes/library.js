'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');

const { prisma } = require('../lib/prisma');
const { requireSession } = require('../lib/authMiddleware');
const { getVisibleLibraryItems, parseTags, youtubeId, TYPE_LABELS } = require('../lib/library');
const { resolveStoragePath } = require('../lib/storage');
const viewer = require('../lib/materialViewer');

// One Library page with three views: everything (with search and category chips), what this person saved, and what
// they opened recently. /library/mine is the "Saved" view (older links keep working).
const VIEWS = ['all', 'saved', 'recent'];
async function renderLibrary(req, res, view) {
  const me = req.profile;
  const { visibleTo } = require('../lib/objectAccess');
  const category = typeof req.query.category === 'string' ? req.query.category : '';
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const [allVisible, items, categories, favorites, recent] = await Promise.all([
    getVisibleLibraryItems(me.organizationId, me.role, {}),
    view === 'all' ? getVisibleLibraryItems(me.organizationId, me.role, { categoryId: category || undefined, q }) : [],
    prisma.libraryCategory.findMany({ where: { organizationId: me.organizationId }, orderBy: { displayOrder: 'asc' } }),
    prisma.libraryFavorite.findMany({ where: { profileId: me.id }, include: { libraryItem: { include: { category: true } } }, orderBy: { createdAt: 'desc' } }),
    view === 'recent' ? prisma.libraryRecentlyViewed.findMany({ where: { profileId: me.id }, include: { libraryItem: { include: { category: true } } }, orderBy: { viewedAt: 'desc' }, take: 20 }) : [],
  ]);
  const usable = (row) => row.libraryItem && !row.libraryItem.archivedAt && visibleTo(row.libraryItem, me);
  const saved = favorites.filter(usable);
  const counts = new Map();
  allVisible.forEach((i) => { if (i.categoryId) counts.set(i.categoryId, (counts.get(i.categoryId) || 0) + 1); });
  res.render('library/index', {
    title: view === 'saved' ? 'My Library' : 'Library',
    view,
    items: view === 'all' ? items : view === 'saved' ? saved.map((f) => f.libraryItem) : [],
    recent: recent.filter(usable),
    total: allVisible.length,
    savedCount: saved.length,
    categories: categories.filter((c) => counts.get(c.id)).map((c) => ({ id: c.id, name: c.name, count: counts.get(c.id) })),
    favoriteIds: new Set(favorites.map((f) => f.libraryItemId)),
    parseTags,
    TYPE_LABELS,
    youtubeId,
    q,
    category,
  });
}

router.get('/library', requireSession, async (req, res) => {
  const view = VIEWS.includes(req.query.view) ? req.query.view : 'all';
  await renderLibrary(req, res, view);
});

router.get('/library/mine', requireSession, (req, res) => renderLibrary(req, res, 'saved'));

function isVisible(visibleRolesJson, role) {
  if (role === 'ADMIN' || !visibleRolesJson) return true;
  return JSON.parse(visibleRolesJson).includes(role);
}

router.get('/library/:id', requireSession, async (req, res) => {
  const me = req.profile;
  const item = await prisma.libraryItem.findFirst({
    where: { id: req.params.id, organizationId: me.organizationId, archivedAt: null },
    include: { category: true },
  });
  if (!item || !isVisible(item.visibleRolesJson, me.role)) return res.status(404).render('not-found', { layout: false });

  const favorite = await prisma.libraryFavorite.findUnique({
    where: { profileId_libraryItemId: { profileId: me.id, libraryItemId: item.id } },
  });

  await prisma.$transaction([
    prisma.libraryItem.update({ where: { id: item.id }, data: { viewCount: { increment: 1 } } }),
    prisma.libraryRecentlyViewed.upsert({
      where: { profileId_libraryItemId: { profileId: me.id, libraryItemId: item.id } },
      update: { viewedAt: new Date() },
      create: { profileId: me.id, libraryItemId: item.id },
    }),
  ]);

  // How this item is shown inside the page (video / audio / image / PDF / readable text). Everyone except Admins gets a view-only page.
  const kind = viewer.viewerKind({ type: item.itemType, storagePath: item.storagePath, mimeType: item.mimeType });
  const text = kind === 'text' ? await viewer.readableText(item.storagePath) : null;
  res.render('library/detail', { title: item.title, item, isFavorite: Boolean(favorite), parseTags, kind, text, youtube: item.itemType === 'LINK' ? youtubeId(item.externalUrl) : null, TYPE_LABELS, paragraphs: viewer.paragraphs, protect: me.role !== 'ADMIN' });
});

router.post('/library/:id/favorite', requireSession, async (req, res) => {
  const me = req.profile;
  res.set('Cache-Control', 'no-store');
  const item = await prisma.libraryItem.findUnique({ where: { id: req.params.id } });
  if (!item || item.organizationId !== me.organizationId || item.archivedAt || !isVisible(item.visibleRolesJson, me.role)) {
    return res.status(404).json({ ok: false, error: 'This material is no longer available.' });
  }
  const where = { profileId_libraryItemId: { profileId: me.id, libraryItemId: item.id } };
  // The browser says which state it wants ("favorite" = 1 / 0) so a double tap or a slow connection
  // can never flip the star the wrong way; without it the call toggles, as before.
  const existing = await prisma.libraryFavorite.findUnique({ where });
  const want = req.body && (req.body.favorite === '1' || req.body.favorite === '0') ? req.body.favorite === '1' : !existing;
  if (want && !existing) await prisma.libraryFavorite.create({ data: { profileId: me.id, libraryItemId: item.id } }).catch(() => undefined); // a concurrent tap already saved it
  if (!want && existing) await prisma.libraryFavorite.deleteMany({ where: { profileId: me.id, libraryItemId: item.id } });
  res.json({ ok: true, favorite: want });
});

// Authenticated, role-gated file streaming. Only Admins may ever receive a
// Content-Disposition that triggers a save dialog — everyone else always
// gets an inline, in-browser render. This is the enforcement point for
// "no one but Admins can download materials".
router.get('/library-file/:id', requireSession, async (req, res) => {
  const me = req.profile;
  const item = await prisma.libraryItem.findUnique({ where: { id: req.params.id } });
  if (!item || item.archivedAt || !item.storagePath) return res.status(404).send('Not found');
  if (item.organizationId !== me.organizationId) return res.status(404).send('Not found');
  if (!isVisible(item.visibleRolesJson, me.role)) return res.status(403).send('Forbidden');

  const wantsDownload = req.query.download === '1';
  if (wantsDownload && me.role !== 'ADMIN') return res.status(403).send('Forbidden');
  // Non-Admins cannot open the raw file as a page of its own (that is how a save / download button appears);
  // embedding it in the page (video, image, PDF viewer) is what they get.
  if (viewer.refusesPageNavigation(req)) return res.status(403).send(viewer.VIEW_ONLY_PAGE);

  const filePath = resolveStoragePath(item.storagePath);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

  res.setHeader('Content-Type', item.mimeType || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    wantsDownload ? `attachment; filename="${encodeURIComponent(item.title)}"` : 'inline'
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // sendFile answers "Range" requests (206 Partial Content) and sends Content-Length, which browsers
  // need to start a video, seek in it and resume it; a plain stream of the whole file did none of that.
  res.sendFile(filePath, { cacheControl: false, dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.status(err.status || 500).send('Not available');
  });
});

module.exports = router;
