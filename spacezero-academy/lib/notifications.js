'use strict';

const { prisma } = require('./prisma');

async function createNotification({ profileId, type, title, body, link }) {
  return prisma.notification.create({ data: { profileId, type, title, body, link } });
}

async function createNotificationForMany(profileIds, { type, title, body, link }) {
  if (profileIds.length === 0) return;
  await prisma.notification.createMany({
    data: profileIds.map((profileId) => ({ profileId, type, title, body, link })),
  });
}

/**
 * Creates the notification at most once per (person, dedupeKey), however often the automation runs —
 * this is what keeps reminders and alerts from turning into spam. Returns true when it was created.
 */
async function notifyOnce(profileId, dedupeKey, { type, title, body, link }) {
  if (await prisma.notification.findUnique({ where: { profileId_dedupeKey: { profileId, dedupeKey } }, select: { id: true } })) return false;
  try {
    await prisma.notification.create({ data: { profileId, dedupeKey, type, title, body, link } });
    return true;
  } catch (err) {
    if (err && err.code === 'P2002') return false; // already sent
    throw err;
  }
}

async function unreadCount(profileId) {
  return prisma.notification.count({ where: { profileId, readAt: null } });
}

module.exports = { createNotification, createNotificationForMany, notifyOnce, unreadCount };
