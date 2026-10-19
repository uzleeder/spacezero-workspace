'use strict';

const express = require('express');
const router = express.Router();

const { prisma } = require('../lib/prisma');
const { requireSession, requireAdmin } = require('../lib/authMiddleware');
const { isBirthdayToday, birthdayLetter, todayParts } = require('../lib/birthdays');
const { excludeOtherAdminsTestProfiles } = require('../lib/loginAsScope');

const DAY_MS = 86400000;

// The person's own birthday card (the greeting notification links here). It shows on the birthday
// itself and for a month afterwards, so a notification opened a day or two late still works.
router.get('/birthday', requireSession, async (req, res) => {
  const me = await prisma.profile.findUnique({ where: { id: req.profile.id }, select: { id: true, fullName: true, dateOfBirth: true } });
  const greeted = await prisma.notification.findFirst({ where: { profileId: me.id, type: 'birthday.greeting', createdAt: { gte: new Date(Date.now() - 30 * DAY_MS) } }, select: { id: true } });
  const show = isBirthdayToday(me.dateOfBirth) || Boolean(greeted);
  res.render('birthday', { title: 'Birthday card', letter: show ? birthdayLetter(me) : null, preview: false, upcoming: [], hasBirthday: Boolean(me.dateOfBirth) });
});

// Admin-only: the exact letter that is sent, and who has a birthday coming up.
router.get('/admin/birthday-preview', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const people = await prisma.profile.findMany({
    where: { organizationId: admin.organizationId, status: 'ACTIVE', dateOfBirth: { not: null }, ...excludeOtherAdminsTestProfiles(admin) },
    select: { id: true, fullName: true, role: true, dateOfBirth: true },
  });
  const today = todayParts();
  const dayOfYear = (month, day) => Date.UTC(2001, month - 1, day); // 2001: a non-leap reference year
  const base = dayOfYear(today.month, today.day);
  const upcoming = people.map((p) => {
    const month = p.dateOfBirth.getUTCMonth() + 1;
    const day = p.dateOfBirth.getUTCDate();
    let next = dayOfYear(month, month === 2 && day === 29 ? 28 : day);
    if (next < base) next += 365 * DAY_MS;
    return { id: p.id, fullName: p.fullName, role: p.role, month, day, inDays: Math.round((next - base) / DAY_MS), today: isBirthdayToday(p.dateOfBirth) };
  }).sort((a, b) => a.inDays - b.inDays).slice(0, 10);
  res.render('birthday', { title: 'Birthday greeting', letter: birthdayLetter(admin), preview: true, upcoming, hasBirthday: true });
});

module.exports = router;
