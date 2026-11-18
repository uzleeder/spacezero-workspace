'use strict';

// Who people reach when Space AI cannot help. Shown under an answer Space AI could not give, as Telegram links.
// Admins answer questions about work and data; the engineer handles technical problems (Space AI not working).
const ADMINS = [
  { name: 'Ali', telegram: 'ali_avove9' },
  { name: 'Joe', telegram: 'Joe_Above9' },
  { name: 'Tom', telegram: 'tom_allen_above9' },
];
const ENGINEER = { name: 'Max', title: 'Engineer', telegram: 'si_leeder' };

const telegramUrl = (username) => `https://t.me/${encodeURIComponent(String(username).replace(/^@/, ''))}`;
const withLinks = (c) => ({ ...c, handle: `@${c.telegram}`, url: telegramUrl(c.telegram) });

/** Everything the page and the corner panel need to draw the contact links. */
function supportContacts() {
  return { admins: ADMINS.map(withLinks), engineer: withLinks(ENGINEER) };
}

module.exports = { supportContacts, telegramUrl };
