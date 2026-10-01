'use strict';

// Passport Details (spec Part 4): only a Passport Number and Expiration Date are stored — never a
// scan/image. The number is treated exactly like a Credential Vault secret (same encryption
// module, same "reveal needs a fresh password + is audited + is rate limited" shape); the
// expiration date stays plaintext because status badges, filters, dashboards and reminders all
// need to read it cheaply across many profiles at once, and the date alone is not the sensitive
// part — the number is.
const { prisma } = require('./prisma');
const { encryptText, decryptText } = require('./credentialCrypto');
const { canViewProfile, isSupervisorOfAgent } = require('./authz');
const { hasCapability } = require('./supervisorCapabilities');

const STATUS = { VALID: 'VALID', EXPIRING_SOON: 'EXPIRING_SOON', EXPIRED: 'EXPIRED' };
const STATUS_LABEL = { VALID: 'Valid', EXPIRING_SOON: 'Expiring Soon', EXPIRED: 'Expired' };
const STATUS_TONE = { VALID: 'badge-success', EXPIRING_SOON: 'badge-warning', EXPIRED: 'badge-danger' };

const aadFor = (profileId) => `passport:${profileId}`;
const encryptPassportNumber = (profileId, number) => encryptText(number, aadFor(profileId));
const decryptPassportNumber = (profileId, stored) => decryptText(stored, aadFor(profileId));

// "••••••1234" — never the full value. Shown to management by default; the plain reveal flow is a
// separate, password-gated, audited action (see routes/passport.js), the same shape as Credential
// Vault reveal.
function maskPassportNumber(number) {
  const clean = String(number || '');
  if (clean.length <= 4) return '•'.repeat(Math.max(0, 4 - clean.length)) + clean;
  return '•'.repeat(clean.length - 4) + clean.slice(-4);
}

// A reasonable, country-agnostic sanity check — passport number formats vary by issuing country,
// so this only rules out obviously-wrong input, never a specific country's exact pattern.
function validatePassportNumber(raw) {
  const v = String(raw || '').trim();
  if (!v) return 'Passport number is required.';
  if (v.length < 5 || v.length > 20) return 'Enter a valid passport number (5-20 characters).';
  if (!/^[A-Za-z0-9]+$/.test(v)) return 'Passport number should contain only letters and numbers.';
  return null;
}

function parseExpirationDate(raw) {
  const v = String(raw || '').trim();
  if (!v) return { error: 'Expiration date is required.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: 'Enter a valid date.' };
  const date = new Date(v + 'T00:00:00.000Z');
  if (Number.isNaN(date.getTime())) return { error: 'Enter a valid date.' };
  return { date };
}

// Calendar-aware month math (real months, not a 30-day approximation) — the one exact-day
// exception is the final "2 weeks" milestone, per spec.
function addMonths(date, months) {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/** VALID (>6 months out) / EXPIRING_SOON (within 6 months) / EXPIRED (past expiration). Three statuses only. */
function passportStatus(expiresAt, now = new Date()) {
  if (!expiresAt) return null;
  if (expiresAt <= now) return STATUS.EXPIRED;
  return now >= addMonths(expiresAt, -6) ? STATUS.EXPIRING_SOON : STATUS.VALID;
}

/**
 * Passport access rules (mirrors lib/employeeAccess.js#credentialAccess's shape):
 *  - Self: always full view + manage of their own passport.
 *  - Admin: full view + manage for anyone they can already see (respects private test profiles).
 *  - Supervisor of that agent: the status word only by default (statusVisible), never the number,
 *    UNLESS explicitly granted the 'passport.viewNumber' capability — never implied by Manage Team
 *    Setup or any other capability.
 *  - Everyone else (including a Flight Expert looking at someone else): no access at all.
 */
async function passportAccess(actor, owner) {
  const none = { view: false, manage: false, statusVisible: false };
  if (!actor || !owner || actor.organizationId !== owner.organizationId) return none;
  if (actor.id === owner.id) return { view: true, manage: true, statusVisible: true };
  if (actor.role === 'ADMIN') return (await canViewProfile(actor, owner.id)) ? { view: true, manage: true, statusVisible: true } : none;
  if (actor.role === 'SUPERVISOR' && (await isSupervisorOfAgent(actor.id, owner.id))) {
    const full = await hasCapability(actor, 'passport.viewNumber');
    return { view: full, manage: false, statusVisible: true };
  }
  return none;
}

async function supervisorsOf(profileId) {
  const rows = await prisma.supervisorAssignment.findMany({ where: { agentId: profileId, unassignedAt: null }, select: { supervisorId: true } });
  return rows.map((r) => r.supervisorId);
}

/**
 * Expiration reminders — reuses the existing notification system's notifyOnce/dedupeKey exactly
 * once per milestone. The dedupeKey embeds the expiration date itself, so renewing a passport
 * (a new expiresAt) automatically gets a fresh set of dedupe keys: nothing needs to "reset" when a
 * passport is renewed, and a milestone that already fired for the OLD date can never block the
 * SAME milestone firing again for the NEW date. Each milestone fires only while `now` sits inside
 * its own window (threshold reached, but the next tighter threshold not yet reached), so entering a
 * passport that already has under 6 months left does not retroactively spam every earlier milestone
 * at once — only the one whose window we are actually in right now.
 */
async function runPassportReminders(organizationId, now = new Date()) {
  const { notifyOnce } = require('./notifications');
  const people = await prisma.profile.findMany({ where: { organizationId, status: 'ACTIVE', passportExpiresAt: { not: null }, testOwnerAdminId: null }, select: { id: true, fullName: true, passportExpiresAt: true } });
  const admins = (await prisma.profile.findMany({ where: { organizationId, role: 'ADMIN', status: 'ACTIVE', testOwnerAdminId: null }, select: { id: true } })).map((a) => a.id);
  let sent = 0;
  for (const person of people) {
    const expiresAt = person.passportExpiresAt;
    const versionKey = expiresAt.toISOString().slice(0, 10);
    const milestones = [
      { key: '6m', label: '6 months', mark: addMonths(expiresAt, -6), until: addMonths(expiresAt, -3) },
      { key: '3m', label: '3 months', mark: addMonths(expiresAt, -3), until: addMonths(expiresAt, -1) },
      { key: '1m', label: '1 month', mark: addMonths(expiresAt, -1), until: new Date(expiresAt.getTime() - 14 * 86400000) },
      { key: '2w', label: '2 weeks', mark: new Date(expiresAt.getTime() - 14 * 86400000), until: expiresAt },
    ];
    for (const m of milestones) {
      if (now < m.mark || now >= m.until) continue; // not in this milestone's window right now
      if (await notifyOnce(person.id, `passport:${person.id}:${versionKey}:${m.key}`, {
        type: 'passport.expiring', title: 'Passport expiring soon', body: `Your passport expires in about ${m.label}. Please renew it soon.`, link: '/my/setup',
      })) sent += 1;
      const recipients = new Set([...(await supervisorsOf(person.id)), ...admins]);
      for (const recipientId of recipients) {
        if (await notifyOnce(recipientId, `passport:${person.id}:${versionKey}:${m.key}:mgmt`, {
          type: 'passport.expiring', title: `Passport expiring: ${person.fullName}`, body: `Expires in about ${m.label}.`, link: `/employees/${person.id}/setup`,
        })) sent += 1;
      }
    }
  }
  return sent;
}

module.exports = {
  STATUS, STATUS_LABEL, STATUS_TONE,
  encryptPassportNumber, decryptPassportNumber, maskPassportNumber,
  validatePassportNumber, parseExpirationDate, addMonths, passportStatus,
  passportAccess, runPassportReminders,
};
