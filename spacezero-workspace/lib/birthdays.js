'use strict';

// Date of birth + the automatic birthday greeting. The date of birth is stored with the passport
// details (it is personal data: shown only to whoever may see those details). On a person's
// birthday the system sends them ONE greeting notification per year (notifyOnce), from the same
// automation pass that sends the other reminders.
const { prisma } = require('./prisma');

const BIRTHDAY_LINK = '/birthday';
// The company works on Tashkent time; "today" for a birthday is the date there, so the greeting
// is not a day early/late for people near midnight UTC.
const TIME_ZONE = 'Asia/Tashkent';

function parseDateOfBirth(raw, now = new Date()) {
  const v = String(raw || '').trim();
  if (!v) return { error: 'Date of birth is required.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: 'Enter a valid date of birth.' };
  const date = new Date(v + 'T00:00:00.000Z');
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== v) return { error: 'Enter a valid date of birth.' };
  if (date > now) return { error: 'Date of birth cannot be in the future.' };
  if (date.getUTCFullYear() < 1900) return { error: 'Enter a valid date of birth.' };
  return { date };
}

/** {year, month, day} of `now` on the company calendar. */
function todayParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Is `dateOfBirth` (a stored UTC date) today's birthday? A 29 Feb birthday is celebrated on 28 Feb in non-leap years. */
function isBirthdayToday(dateOfBirth, now = new Date()) {
  if (!dateOfBirth) return false;
  const today = todayParts(now);
  let month = dateOfBirth.getUTCMonth() + 1;
  let day = dateOfBirth.getUTCDate();
  if (month === 2 && day === 29 && !isLeapYear(today.year)) day = 28;
  return month === today.month && day === today.day;
}

const firstNameOf = (profile) => String((profile && profile.fullName) || '').trim().split(/\s+/)[0] || 'there';

/** The greeting letter — one source for the notification, the card page and the admin preview. */
function birthdayLetter(profile) {
  const name = firstNameOf(profile);
  return {
    title: `Happy Birthday, ${name}! 🎂`,
    notification: 'The whole SpaceZero team wishes you a wonderful day. Open your birthday card.',
    greeting: `Dear ${name},`,
    headline: 'Happy Birthday! 🎉',
    paragraphs: [
      'Today is your day, and everyone at SpaceZero wants you to know how much we value having you on the team. The effort, energy and care you bring to your work every day make all of us stronger — thank you.',
      'We wish you good health, joy with the people you love, and many reasons to be proud of what you achieve in the year ahead. Take a moment today to celebrate yourself — you have earned it.',
    ],
    closing: 'With warm wishes,',
    signature: 'The SpaceZero Team',
    company: 'Above9 Travel',
  };
}

/**
 * Sends today's birthday greetings for one organization. Safe to run repeatedly: a person gets one
 * greeting per year. Another admin's private test profiles are skipped, like every other automation.
 */
async function runBirthdayGreetings(organizationId, now = new Date()) {
  const { notifyOnce } = require('./notifications');
  const people = await prisma.profile.findMany({
    where: { organizationId, status: 'ACTIVE', dateOfBirth: { not: null }, testOwnerAdminId: null },
    select: { id: true, fullName: true, dateOfBirth: true },
  });
  const year = todayParts(now).year;
  let sent = 0;
  for (const person of people) {
    if (!isBirthdayToday(person.dateOfBirth, now)) continue;
    const letter = birthdayLetter(person);
    if (await notifyOnce(person.id, `birthday:${person.id}:${year}`, { type: 'birthday.greeting', title: letter.title, body: letter.notification, link: BIRTHDAY_LINK })) sent += 1;
  }
  return sent;
}

module.exports = { BIRTHDAY_LINK, parseDateOfBirth, isBirthdayToday, birthdayLetter, runBirthdayGreetings, todayParts };
