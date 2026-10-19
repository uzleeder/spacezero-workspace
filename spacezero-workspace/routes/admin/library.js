'use strict';

const express = require('express');
const router = express.Router();
const { unlimitedUpload, withCleanup } = require('../../lib/uploads');

const { prisma } = require('../../lib/prisma');
const { requireAdmin } = require('../../lib/authMiddleware');
const { LibraryItemSchema, LibraryCategorySchema } = require('../../lib/validation');
const { validateUpload, saveUpload } = require('../../lib/storage');
const { logAudit } = require('../../lib/audit');

const upload = unlimitedUpload(); // any size: streamed to disk (lib/uploads.js)

async function loadPageData(admin) {
  const [categories, items] = await Promise.all([
    prisma.libraryCategory.findMany({ where: { organizationId: admin.organizationId }, orderBy: { displayOrder: 'asc' } }),
    prisma.libraryItem.findMany({
      where: { organizationId: admin.organizationId, archivedAt: null },
      include: { category: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  return { categories, items };
}

router.get('/library', requireAdmin, async (req, res) => {
  const { categories, items } = await loadPageData(req.profile);
  res.render('admin/library', { title: 'Manage library', categories, items, error: null, fieldErrors: {} });
});

router.post('/library/categories', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const parsed = LibraryCategorySchema.safeParse({ name: req.body.name });
  if (parsed.success) {
    await prisma.libraryCategory.create({ data: { organizationId: admin.organizationId, name: parsed.data.name } });
  }
  res.redirect('/admin/library');
});

router.post('/library/items', requireAdmin, withCleanup(upload.single('file')), async (req, res) => {
  const admin = req.profile;
  const visibleRoles = Array.isArray(req.body.visibleRoles) ? req.body.visibleRoles : req.body.visibleRoles ? [req.body.visibleRoles] : [];

  const parsed = LibraryItemSchema.safeParse({
    title: req.body.title,
    description: req.body.description || undefined,
    categoryId: req.body.categoryId || undefined,
    itemType: req.body.itemType,
    externalUrl: req.body.externalUrl || undefined,
    tags: req.body.tags || undefined,
    visibleRoles,
  });

  const rerender = async (error) => {
    const { categories, items } = await loadPageData(admin);
    res.render('admin/library', { title: 'Manage library', categories, items, error, fieldErrors: {} });
  };

  if (!parsed.success) return rerender('Please fill in the form correctly.');
  const data = parsed.data;
  if (data.categoryId && !await prisma.libraryCategory.findFirst({ where: { id: data.categoryId, organizationId: admin.organizationId } })) return res.status(400).send('Invalid category');

  let storagePath;
  let mimeType;
  const uploadNeeded = data.itemType !== 'LINK' && data.itemType !== 'NOTE';

  if (uploadNeeded) {
    if (!req.file) return rerender('Please choose a file to upload.');
    const validationError = validateUpload(data.itemType, req.file);
    if (validationError) return rerender(validationError);
    const saved = await saveUpload(req.file, 'library');
    storagePath = saved.storagePath;
    mimeType = saved.mimeType;
  } else if (data.itemType === 'LINK' && !data.externalUrl) {
    return rerender('Enter a URL for this link.');
  }

  const tags = data.tags ? data.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];

  const item = await prisma.libraryItem.create({
    data: {
      organizationId: admin.organizationId,
      categoryId: data.categoryId || undefined,
      title: data.title,
      description: data.description,
      itemType: data.itemType,
      storagePath,
      mimeType,
      externalUrl: data.itemType === 'LINK' ? data.externalUrl : undefined,
      tagsJson: JSON.stringify(tags),
      visibleRolesJson: data.visibleRoles && data.visibleRoles.length > 0 ? JSON.stringify(data.visibleRoles) : null,
      createdById: admin.id,
    },
  });

  await logAudit({
    organizationId: admin.organizationId,
    actorId: admin.id,
    action: 'library.item_created',
    targetTable: 'LibraryItem',
    targetId: item.id,
    metadata: { title: item.title, itemType: item.itemType },
  });

  res.redirect('/admin/library');
});

router.post('/library/items/:id/archive', requireAdmin, async (req, res) => {
  const admin = req.profile;
  await prisma.libraryItem.update({ where: { id: req.params.id }, data: { archivedAt: new Date() } });
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'library.item_archived', targetTable: 'LibraryItem', targetId: req.params.id });
  res.json({ ok: true });
});

router.get('/library/items/:id', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const item = await prisma.libraryItem.findFirst({
    where: { id: req.params.id, organizationId: admin.organizationId },
    include: { category: true },
  });
  if (!item) return res.status(404).render('not-found', { layout: false });
  const categories = await prisma.libraryCategory.findMany({ where: { organizationId: admin.organizationId }, orderBy: { displayOrder: 'asc' } });
  res.render('admin/library-detail', { title: item.title, item, categories, error: null });
});

router.post('/library/items/:id/edit', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const existing = await prisma.libraryItem.findFirst({ where: { id: req.params.id, organizationId: admin.organizationId } });
  if (!existing) return res.status(404).render('not-found', { layout: false });

  const visibleRoles = Array.isArray(req.body.visibleRoles) ? req.body.visibleRoles : req.body.visibleRoles ? [req.body.visibleRoles] : [];
  const parsed = LibraryItemSchema.safeParse({
    title: req.body.title,
    description: req.body.description || undefined,
    categoryId: req.body.categoryId || undefined,
    itemType: existing.itemType,
    externalUrl: req.body.externalUrl || undefined,
    tags: req.body.tags || undefined,
    visibleRoles,
  });

  const rerender = async (error) => {
    const categories = await prisma.libraryCategory.findMany({ where: { organizationId: admin.organizationId }, orderBy: { displayOrder: 'asc' } });
    const item = await prisma.libraryItem.findFirst({ where: { id: existing.id }, include: { category: true } });
    res.render('admin/library-detail', { title: item.title, item, categories, error });
  };

  if (!parsed.success) return rerender('Please fill in the form correctly.');
  const data = parsed.data;
  if (data.categoryId && !await prisma.libraryCategory.findFirst({ where: { id: data.categoryId, organizationId: admin.organizationId } })) return res.status(400).send('Invalid category');
  if (existing.itemType === 'LINK' && !data.externalUrl) return rerender('Enter a URL for this link.');

  const tags = data.tags ? data.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];

  await prisma.libraryItem.update({
    where: { id: existing.id },
    data: {
      title: data.title,
      description: data.description,
      categoryId: data.categoryId || null,
      externalUrl: existing.itemType === 'LINK' ? data.externalUrl : existing.externalUrl,
      tagsJson: JSON.stringify(tags),
      visibleRolesJson: data.visibleRoles && data.visibleRoles.length > 0 ? JSON.stringify(data.visibleRoles) : null,
    },
  });

  await logAudit({
    organizationId: admin.organizationId,
    actorId: admin.id,
    action: 'library.item_edited',
    targetTable: 'LibraryItem',
    targetId: existing.id,
    metadata: { title: data.title },
  });

  res.redirect(`/admin/library/items/${existing.id}`);
});

module.exports = router;
