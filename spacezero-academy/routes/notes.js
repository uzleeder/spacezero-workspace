'use strict';

const express = require('express');
const router = express.Router();

const { prisma } = require('../lib/prisma');
const { requireRole } = require('../lib/authMiddleware');
const { NoteSchema } = require('../lib/validation');
const { logAudit } = require('../lib/audit');

const canUseNotes = requireRole('TRAVEL_AGENT', 'FLIGHT_EXPERT');

router.get('/notes', canUseNotes, async (req, res) => {
  const showSaved = req.query.view === 'saved';
  const notes = await prisma.note.findMany({
    where: { profileId: req.profile.id, ...(showSaved ? { isSaved: true } : {}) },
    orderBy: { updatedAt: 'desc' },
  });
  res.render('notes', { title: 'Notes', notes, showSaved, error: null });
});

router.post('/notes', canUseNotes, async (req, res) => {
  const actor = req.profile;
  const parsed = NoteSchema.safeParse({ title: req.body.title || undefined, content: req.body.content });
  if (!parsed.success) {
    const notes = await prisma.note.findMany({ where: { profileId: actor.id }, orderBy: { updatedAt: 'desc' } });
    return res.render('notes', { title: 'Notes', notes, showSaved: false, error: 'Write something before saving.' });
  }

  const note = await prisma.note.create({
    data: {
      organizationId: actor.organizationId,
      profileId: actor.id,
      title: parsed.data.title || null,
      content: parsed.data.content,
    },
  });

  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'note.created', targetTable: 'Note', targetId: note.id });
  res.redirect('/notes');
});

router.post('/notes/:id', canUseNotes, async (req, res) => {
  const actor = req.profile;
  const existing = await prisma.note.findFirst({ where: { id: req.params.id, profileId: actor.id } });
  if (!existing) return res.status(404).render('not-found', { layout: false });

  const parsed = NoteSchema.safeParse({ title: req.body.title || undefined, content: req.body.content });
  if (!parsed.success) {
    const notes = await prisma.note.findMany({ where: { profileId: actor.id }, orderBy: { updatedAt: 'desc' } });
    return res.render('notes', { title: 'Notes', notes, showSaved: false, error: 'Write something before saving.' });
  }

  await prisma.note.update({
    where: { id: existing.id },
    data: { title: parsed.data.title || null, content: parsed.data.content },
  });

  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'note.edited', targetTable: 'Note', targetId: existing.id });
  res.redirect('/notes');
});

router.post('/notes/:id/save', canUseNotes, async (req, res) => {
  const actor = req.profile;
  const existing = await prisma.note.findFirst({ where: { id: req.params.id, profileId: actor.id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const isSaved = !existing.isSaved;
  await prisma.note.update({ where: { id: existing.id }, data: { isSaved } });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: isSaved ? 'note.saved' : 'note.unsaved', targetTable: 'Note', targetId: existing.id });
  res.json({ ok: true, isSaved });
});

router.post('/notes/:id/delete', canUseNotes, async (req, res) => {
  const actor = req.profile;
  const existing = await prisma.note.findFirst({ where: { id: req.params.id, profileId: actor.id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });

  await prisma.note.delete({ where: { id: existing.id } });
  await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: 'note.deleted', targetTable: 'Note', targetId: existing.id });
  res.json({ ok: true });
});

module.exports = router;
