'use strict';

const express = require('express');
const router = express.Router();
const { unlimitedUpload, withCleanup } = require('../../lib/uploads');

const { prisma } = require('../../lib/prisma');
const { requireAdmin } = require('../../lib/authMiddleware');
const { LibraryItemSchema, LibraryCategorySchema } = require('../../lib/validation');
const { validateUpload, saveUpload } = require('../../lib/storage');
const { logAudit } = require('../../lib/audit');
const { inferItemType, chosenRoles, audienceLabel, parseTags, parseRoles, TYPE_LABELS, ROLE_LABELS } = require('../../lib/library');

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
  const counts = new Map();
  items.forEach((i) => { if (i.categoryId) counts.set(i.categoryId, (counts.get(i.categoryId) || 0) + 1); });
  return { categories: categories.map((c) => Object.assign(c, { count: counts.get(c.id) || 0 })), items };
}

// The Manage library page. panel=add / panel=categories opens that side panel (after a mistake, with what was typed).
async function renderManage(req, res, extra) {
  const { categories, items } = await loadPageData(req.profile);
  res.status((extra && extra.status) || 200).render('admin/library', Object.assign({
    title: 'Manage library', categories, items, audienceLabel, parseTags, TYPE_LABELS, ROLE_LABELS,
    error: null, form: {}, panel: ['add', 'categories'].includes(req.query.panel) ? req.query.panel : '',
    catError: typeof req.query.catError === 'string' ? req.query.catError.slice(0, 200) : '',
    saved: req.query.saved === 'added' ? 'added' : '',
  }, extra || {}));
}

router.get('/library', requireAdmin, (req, res) => renderManage(req, res));

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const backToCategories = (res, catError) => res.redirect('/admin/library?panel=categories' + (catError ? '&catError=' + encodeURIComponent(catError) : ''));

router.post('/library/categories', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const parsed = LibraryCategorySchema.safeParse({ name: req.body.name });
  if (!parsed.success) return backToCategories(res, 'Write a category name of at least 2 letters.');
  const existing = await prisma.libraryCategory.findMany({ where: { organizationId: admin.organizationId }, select: { name: true } });
  if (existing.some((c) => sameName(c.name, parsed.data.name))) return backToCategories(res, `There is already a category called "${parsed.data.name}".`);
  const last = await prisma.libraryCategory.aggregate({ where: { organizationId: admin.organizationId }, _max: { displayOrder: true } });
  const cat = await prisma.libraryCategory.create({ data: { organizationId: admin.organizationId, name: parsed.data.name, displayOrder: (last._max.displayOrder || 0) + 1 } });
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'library.category_created', targetTable: 'LibraryCategory', targetId: cat.id, metadata: { name: cat.name } });
  backToCategories(res);
});

// Rename a category (its materials keep it).
router.post('/library/categories/:id', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const cat = await prisma.libraryCategory.findFirst({ where: { id: req.params.id, organizationId: admin.organizationId } });
  if (!cat) return res.status(404).render('not-found', { layout: false });
  const parsed = LibraryCategorySchema.safeParse({ name: req.body.name });
  if (!parsed.success) return backToCategories(res, 'Write a category name of at least 2 letters.');
  const others = await prisma.libraryCategory.findMany({ where: { organizationId: admin.organizationId, NOT: { id: cat.id } }, select: { name: true } });
  if (others.some((c) => sameName(c.name, parsed.data.name))) return backToCategories(res, `There is already a category called "${parsed.data.name}".`);
  await prisma.libraryCategory.update({ where: { id: cat.id }, data: { name: parsed.data.name } });
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'library.category_renamed', targetTable: 'LibraryCategory', targetId: cat.id, metadata: { from: cat.name, to: parsed.data.name } });
  backToCategories(res);
});

// Remove a category, only once no material uses it (archived materials simply lose the category).
router.post('/library/categories/:id/delete', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const cat = await prisma.libraryCategory.findFirst({ where: { id: req.params.id, organizationId: admin.organizationId } });
  if (!cat) return res.status(404).render('not-found', { layout: false });
  const inUse = await prisma.libraryItem.count({ where: { organizationId: admin.organizationId, categoryId: cat.id, archivedAt: null } });
  if (inUse) return backToCategories(res, `"${cat.name}" still has ${inUse} material${inUse === 1 ? '' : 's'}. Move ${inUse === 1 ? 'it' : 'them'} to another category first.`);
  await prisma.libraryCategory.delete({ where: { id: cat.id } });
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'library.category_removed', targetTable: 'LibraryCategory', targetId: cat.id, metadata: { name: cat.name } });
  backToCategories(res);
});

// Add material in three steps: what it is (a file, a link or a short note), how it is described, and who can see it.
// The type of a file is worked out from the file itself; older clients that still send itemType keep working.
router.post('/library/items', requireAdmin, withCleanup(upload.single('file')), async (req, res) => {
  const admin = req.profile;
  const source = ['file', 'link', 'note'].includes(req.body.source) ? req.body.source : null;
  let itemType = req.body.itemType;
  if (source === 'link') itemType = 'LINK';
  else if (source === 'note') itemType = 'NOTE';
  else if (source === 'file' || !itemType) itemType = inferItemType(req.file) || (source === 'file' && req.file ? 'UNKNOWN' : itemType);
  const visibleRoles = chosenRoles(req.body);
  const description = source === 'note' ? req.body.noteText || req.body.description : req.body.description;

  const rerender = (error) => renderManage(req, res, { status: 400, error, form: req.body, panel: 'add' });
  if (source === 'file' && !req.file) return rerender('Choose the file to upload.');
  if (itemType === 'UNKNOWN') return rerender('This kind of file cannot be added. Use a video, audio, PDF, slides (PPT), a Word document or an image.');
  if (source === 'note' && !(description || '').trim()) return rerender('Write the note.');
  if (req.body.audience === 'some' && !visibleRoles.length) return rerender('Choose at least one role, or choose Everyone.');

  const parsed = LibraryItemSchema.safeParse({
    title: req.body.title,
    description: description || undefined,
    categoryId: req.body.categoryId || undefined,
    itemType,
    externalUrl: req.body.externalUrl || undefined,
    tags: req.body.tags || undefined,
    visibleRoles,
  });

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first && first.path[0];
    return rerender(field === 'title' ? 'Write a title of at least 2 letters.' : field === 'externalUrl' ? 'The link must start with http:// or https://.' : 'Please check the form.');
  }
  const data = parsed.data;
  if (data.categoryId && !await prisma.libraryCategory.findFirst({ where: { id: data.categoryId, organizationId: admin.organizationId } })) return res.status(400).send('Invalid category');

  let storagePath;
  let mimeType;
  const uploadNeeded = data.itemType !== 'LINK' && data.itemType !== 'NOTE';

  if (uploadNeeded) {
    if (!req.file) return rerender('Choose the file to upload.');
    const validationError = validateUpload(data.itemType, req.file);
    if (validationError) return rerender(validationError);
    const saved = await saveUpload(req.file, 'library');
    storagePath = saved.storagePath;
    mimeType = saved.mimeType;
  } else if (data.itemType === 'LINK' && !data.externalUrl) {
    return rerender('Paste the link (it starts with https://).');
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

  res.redirect('/admin/library?saved=added');
});

router.post('/library/items/:id/archive', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const done = await prisma.libraryItem.updateMany({ where: { id: req.params.id, organizationId: admin.organizationId, archivedAt: null }, data: { archivedAt: new Date() } });
  if (!done.count) return res.status(404).json({ ok: false, error: 'Not found' });
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
  res.render('admin/library-detail', { title: item.title, item, categories, error: null, saved: req.query.saved === '1', TYPE_LABELS, ROLE_LABELS, parseRoles });
});

router.post('/library/items/:id/edit', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const existing = await prisma.libraryItem.findFirst({ where: { id: req.params.id, organizationId: admin.organizationId } });
  if (!existing) return res.status(404).render('not-found', { layout: false });

  const visibleRoles = chosenRoles(req.body);
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
    res.status(400).render('admin/library-detail', { title: item.title, item, categories, error, saved: false, TYPE_LABELS, ROLE_LABELS, parseRoles });
  };

  if (req.body.audience === 'some' && !visibleRoles.length) return rerender('Choose at least one role, or choose Everyone.');
  if (!parsed.success) return rerender('Write a title of at least 2 letters.');
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

  res.redirect(`/admin/library/items/${existing.id}?saved=1`);
});

module.exports = router;
