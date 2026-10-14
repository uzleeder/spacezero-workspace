'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');

const { prisma } = require('../lib/prisma');
const { requireSession } = require('../lib/authMiddleware');
const { getVisibleLibraryItems, parseTags } = require('../lib/library');
const { resolveStoragePath } = require('../lib/storage');

router.get('/library', requireSession, async (req, res) => {
  const me = req.profile;
  const [items, categories, favorites] = await Promise.all([
    getVisibleLibraryItems(me.organizationId, me.role, { categoryId: req.query.category, q: req.query.q }),
    prisma.libraryCategory.findMany({ where: { organizationId: me.organizationId }, orderBy: { displayOrder: 'asc' } }),
    prisma.libraryFavorite.findMany({ where: { profileId: me.id } }),
  ]);
  const favoriteIds = new Set(favorites.map((f) => f.libraryItemId));
  res.render('library/index', {
    title: 'Library',
    items,
    categories,
    favoriteIds,
    parseTags,
    q: req.query.q || '',
    category: req.query.category || '',
  });
});

router.get('/library/mine', requireSession, async (req, res) => {
  const [favorites, recent] = await Promise.all([
    prisma.libraryFavorite.findMany({
      where: { profileId: req.profile.id },
      include: { libraryItem: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.libraryRecentlyViewed.findMany({
      where: { profileId: req.profile.id },
      include: { libraryItem: true },
      orderBy: { viewedAt: 'desc' },
      take: 10,
    }),
  ]);
  res.render('library/mine', { title: 'My Library', favorites: favorites.filter(row => require('../lib/objectAccess').visibleTo(row.libraryItem, req.profile)), recent: recent.filter(row => require('../lib/objectAccess').visibleTo(row.libraryItem, req.profile)) });
});

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

  res.render('library/detail', { title: item.title, item, isFavorite: Boolean(favorite), parseTags });
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
