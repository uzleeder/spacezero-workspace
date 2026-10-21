'use strict';

// One person should have ONE open copy of a training. Assigning a training someone already has (and has not finished)
// used to create a second copy: the old one stayed Overdue for ever, kept sending its daily reminder, and new attempts
// only counted on the newest copy. Now the open copy is moved onto the new assignment (their progress is kept, the new
// due date applies), and untouched leftovers from earlier duplicates are removed. A finished training is never
// touched: assigning it again is a fresh round of it.
const { prisma } = require('./prisma');

const isOpen = (recipient) => !recipient.attempts[0] || recipient.attempts[0].status !== 'COMPLETED'; // attempts newest first: the last one is the submission when finished
const hasProgress = (recipient) => recipient.attempts.some((a) => a.status !== 'NOT_STARTED' || a.completedAt || a.assessmentId);

/**
 * The person's open copies of a course (and of one specific practice, or of none): newest first.
 * Returns Map(profileId -> { keep, extras }): `keep` is the open copy to carry on with (the one worked on, else the newest),
 * `extras` are the other open copies nobody has touched.
 */
async function openCopies(db, { organizationId, courseId, assessmentId = null, profileIds }) {
  const rows = await db.trainingAssignmentRecipient.findMany({
    where: { profileId: { in: profileIds }, assignment: { organizationId, courseId, assessmentId: assessmentId || null } },
    include: { attempts: { orderBy: { attemptNumber: 'desc' } } },
    orderBy: { createdAt: 'desc' },
  });
  const byPerson = new Map();
  // a copy someone has worked on is the one to keep (newest first among those), then the newest untouched one
  const ordered = rows.filter(isOpen).sort((a, b) => Number(hasProgress(b)) - Number(hasProgress(a)));
  for (const r of ordered) {
    const entry = byPerson.get(r.profileId) || { keep: null, extras: [] };
    if (!entry.keep) entry.keep = r; else if (!hasProgress(r)) entry.extras.push(r);
    byPerson.set(r.profileId, entry);
  }
  return byPerson;
}

/** Removes assignments that no longer have anybody on them (after their recipients moved elsewhere). */
const dropEmptyAssignments = (db, ids) => (ids.length ? db.trainingAssignment.deleteMany({ where: { id: { in: ids }, recipients: { none: {} } } }) : { count: 0 });

/**
 * Clean-up of duplicates that already exist: for each person, course and practice with several open copies, keeps the
 * newest and removes the older ones nobody has touched. `dryRun` only counts. Returns { people, removed }.
 */
async function mergeDuplicateOpenCopies(organizationId, { dryRun = true } = {}) {
  const recipients = await prisma.trainingAssignmentRecipient.findMany({ where: { assignment: { organizationId } }, select: { profileId: true, assignment: { select: { courseId: true, assessmentId: true } } } });
  const groups = new Map();
  for (const r of recipients) {
    const key = `${r.assignment.courseId}|${r.assignment.assessmentId || ''}`;
    if (!groups.has(key)) groups.set(key, { courseId: r.assignment.courseId, assessmentId: r.assignment.assessmentId, profiles: new Set() });
    groups.get(key).profiles.add(r.profileId);
  }
  let people = 0; let removed = 0; const emptied = new Set();
  for (const g of groups.values()) {
    const copies = await openCopies(prisma, { organizationId, courseId: g.courseId, assessmentId: g.assessmentId, profileIds: [...g.profiles] });
    for (const { extras } of copies.values()) {
      if (!extras.length) continue;
      people += 1; removed += extras.length;
      if (dryRun) continue;
      for (const e of extras) { emptied.add(e.assignmentId); await prisma.trainingAssignmentRecipient.delete({ where: { id: e.id } }); }
    }
  }
  if (!dryRun) await dropEmptyAssignments(prisma, [...emptied]);
  return { people, removed, dryRun };
}

module.exports = { openCopies, dropEmptyAssignments, mergeDuplicateOpenCopies, isOpen, hasProgress };
