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

// The 3 most recent notifications for the topbar bell dropdown — a preview, not the full page.
// Opening the dropdown must NOT mark these read, so this is a plain read with no side effect.
async function recentPreview(profileId, limit = 3) {
  return prisma.notification.findMany({
    where: { profileId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

// Compact relative time for the dropdown preview ("5m ago", "3h ago"); the full Notifications
// page keeps showing the exact timestamp.
function formatRelativeTime(date) {
  const diffMs = Date.now() - new Date(date).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 7) return days + 'd ago';
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return weeks + 'w ago';
  return new Date(date).toLocaleDateString('en-US');
}

module.exports = { createNotification, createNotificationForMany, notifyOnce, unreadCount, recentPreview, formatRelativeTime };
