'use strict';

// Office Management -> Activity: one row per change to an asset, desk or repair - who, when, what (before/after of the
// changed fields only). Written in the same transaction as the change itself. Never holds a credential: callers pass
// plain record fields, and desk passwords are only ever logged as "password changed: yes/no".
const { prisma } = require('./prisma');

const ACTIONS = {
  CREATED: 'Added', UPDATED: 'Details changed', CONDITION_CHANGED: 'Condition changed', LOCATION_CHANGED: 'Location changed',
  ASSIGNED: 'Assigned', TRANSFERRED: 'Transferred', RETURNED: 'Returned', RETIRED: 'Retired', RESTORED: 'Restored',
  REPAIR_OPENED: 'Repair opened', REPAIR_UPDATED: 'Repair updated', REPAIR_RESOLVED: 'Repair resolved', REPAIR_CANCELLED: 'Repair cancelled', REPAIR_REOPENED: 'Repair reopened',
  DESK_ADDED: 'Desk added', DESK_UPDATED: 'Desk changed', DESK_REMOVED: 'Desk removed',
};
const FORBIDDEN = /password|passwordEnc|secret|credential/i;

/** Records one change. `db` is the transaction (or prisma). */
function log(db, actor, { itemId = null, deskId = null, repairId = null, action, summary, before = null, after = null }) {
  const safe = (o) => (o && Object.keys(o).length ? JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => !FORBIDDEN.test(k)))) : null);
  return db.officeActivity.create({
    data: { organizationId: actor.organizationId, itemId, deskId, repairId, action, summary: String(summary).slice(0, 400), beforeJson: safe(before), afterJson: safe(after), actorId: actor.id, actorName: actor.fullName },
  });
}

/** Searchable, paginated activity (newest first). */
async function list(actor, { q = '', action = '', item = '', page = 1, per = 50 } = {}) {
  const where = { organizationId: actor.organizationId };
  if (ACTIONS[action]) where.action = action;
  if (item) where.itemId = String(item);
  const text = String(q || '').trim().slice(0, 80);
  if (text) where.OR = [{ summary: { contains: text } }, { actorName: { contains: text } }];
  const total = await prisma.officeActivity.count({ where });
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(Math.max(1, page), pages);
  const rows = await prisma.officeActivity.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (p - 1) * per, take: per });
  return { rows: rows.map((r) => ({ ...r, before: parse(r.beforeJson), after: parse(r.afterJson) })), total, page: p, pages };
}
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

module.exports = { ACTIONS, log, list };
