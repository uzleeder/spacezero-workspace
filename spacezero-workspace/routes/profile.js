'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { mkdir, writeFile } = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { prisma } = require('../lib/prisma');
const { requireSession } = require('../lib/authMiddleware');
const { loadProfileOverview } = require('../lib/profileOverview');
const { hashPassword, verifyPassword, passwordPolicyErrors } = require('../lib/password');
const { logAudit } = require('../lib/audit');
const { ContactInfoSchema } = require('../lib/validation');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const ALLOWED_PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const AVATAR_DIR = path.join(require('../lib/uploadRoot').UPLOAD_ROOT, 'avatars');

router.use('/profile', requireSession, async (req, res, next) => {
  res.locals.personalSection = req.query.section === 'security' || req.path === '/password' ? 'security' : 'profile';
  res.locals.empTabs = await require('../lib/employeeTabs').tabsForRequest(req, req.profile);
  next();
});

router.get('/account', requireSession, (req, res) => res.redirect('/profile?section=security#account-security'));

router.get('/profile', requireSession, async (req, res) => {
  const data = await loadProfileOverview(req.profile.id);
  res.locals.personalAccounts = req.profile.role === 'ADMIN' ? await prisma.profile.findMany({
    where: { ...require('../lib/loginAsScope').loginAsScope(req.profile), testOwnerAdminId: req.profile.id },
    select: { id: true, fullName: true, username: true, role: true },
    orderBy: { role: 'asc' },
  }) : [];
  res.render('profile', { title: 'My Profile', data, canRecordEvidence: false, photoError: null, passwordError: null, passwordSaved: false });
});

router.post('/profile/password', requireSession, async (req, res) => {
  const profile = req.profile;
  const rerender = async (passwordError) => {
    const data = await loadProfileOverview(profile.id);
    res.render('profile', { title: 'My Profile', data, canRecordEvidence: false, photoError: null, passwordError, passwordSaved: false });
  };

  const { currentPassword, password, confirmPassword } = req.body;
  if (!currentPassword || !(await verifyPassword(currentPassword, profile.passwordHash))) {
    return rerender('Your current password is incorrect.');
  }
  if (password !== confirmPassword) return rerender('Passwords do not match.');
  const policyErrors = passwordPolicyErrors(password || '');
  if (policyErrors.length) return rerender(policyErrors.join(' '));

  const passwordHash = await hashPassword(password);
  await prisma.$transaction([
    prisma.profile.update({ where: { id: profile.id }, data: { passwordHash } }),
    prisma.session.deleteMany({ where: { profileId: profile.id } }),
    prisma.passwordResetToken.updateMany({ where: { profileId: profile.id, usedAt: null }, data: { usedAt: new Date() } }),
  ]);
  await require('../lib/session').createSession(res, profile.id, { ipAddress: req.ip });
  await logAudit({ organizationId: profile.organizationId, actorId: profile.id, action: 'auth.password_changed' });

  const data = await loadProfileOverview(profile.id);
  res.render('profile', { title: 'My Profile', data, canRecordEvidence: false, photoError: null, passwordError: null, passwordSaved: true });
});

// Contact numbers (business card info) — Travel Agents only, editable by
// the agent themselves.
router.post('/profile/contact', requireSession, async (req, res) => {
  const profile = req.profile;
  if (profile.role !== 'TRAVEL_AGENT') return res.status(403).render('forbidden');

  const parsed = ContactInfoSchema.safeParse({
    phonePrimary: req.body.phonePrimary || undefined,
    phoneSecondary: req.body.phoneSecondary || undefined,
    whatsappNumber: req.body.whatsappNumber || undefined,
    telegramContact: req.body.telegramContact || undefined,
    phoneUzbekistan: req.body.phoneUzbekistan || undefined,
  });
  if (!parsed.success) return res.redirect('/profile');

  await prisma.profile.update({
    where: { id: profile.id },
    data: {
      phonePrimary: parsed.data.phonePrimary || null,
      phoneSecondary: parsed.data.phoneSecondary || null,
      whatsappNumber: parsed.data.whatsappNumber || null,
      telegramContact: parsed.data.telegramContact || null,
      phoneUzbekistan: parsed.data.phoneUzbekistan || null,
    },
  });
  res.redirect('/profile');
});

// Profile photos live under /static/uploads/avatars, but lib/privateUploads.js
// intercepts that path and re-checks session/organization before serving —
// they are not actually open static files.
router.post('/profile/photo', requireSession, upload.single('photo'), async (req, res) => {
  const rerender = async (photoError) => {
    const data = await loadProfileOverview(req.profile.id);
    res.render('profile', { title: 'My Profile', data, canRecordEvidence: false, photoError });
  };

  if (!req.file) return rerender('Please choose an image to upload.');
  const uploadError = require('../lib/storage').validateUpload('IMAGE', req.file);
  if (uploadError) return rerender(uploadError);
  if (!ALLOWED_PHOTO_TYPES.includes(req.file.mimetype)) {
    return rerender('Only PNG, JPEG, or WEBP images are allowed.');
  }

  await mkdir(AVATAR_DIR, { recursive: true });
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[req.file.mimetype];
  const filename = `${req.profile.id}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  await writeFile(path.join(AVATAR_DIR, filename), req.file.buffer);

  await prisma.profile.update({ where: { id: req.profile.id }, data: { photoUrl: `/static/uploads/avatars/${filename}` } });
  res.redirect('/profile');
});

module.exports = router;
