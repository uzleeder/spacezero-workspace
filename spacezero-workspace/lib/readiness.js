'use strict';

// ONE simple status per employee — deliberately not a score. It answers "can this person work yet, and is
// anything wrong?" from three facts the system already keeps: is the profile activated, is the required
// setup done, is the mandatory training done. Everything comes from the same server-side calculations the
// setup and training screens use, so it can never disagree with them.
//   Not Activated     the invitation has not been accepted yet
//   Needs Attention   something overdue, blocked or failed (an overdue setup item or mandatory training,
//                     a setup issue, a retake that is required)
//   Setup Required    required setup is not finished (and nothing is overdue)
//   Training Required mandatory training is not finished (and nothing is overdue)
//   Ready             activated, set up and mandatory training done
const { loadSetupForProfiles } = require('./employeeSetup');
const { loadLearning } = require('./teamIntel');

const STATUS = {
  NOT_ACTIVATED: { label: 'Not Activated', tone: '' },
  NEEDS_ATTENTION: { label: 'Needs Attention', tone: 'badge-danger' },
  SETUP_REQUIRED: { label: 'Setup Required', tone: 'badge-warning' },
  TRAINING_REQUIRED: { label: 'Training Required', tone: 'badge-warning' },
  READY: { label: 'Ready', tone: 'badge-success' },
};
const KEYS = Object.keys(STATUS);

/** Pure decision from the three facts. */
function decide({ profile, setup, learning }) {
  if (profile.status === 'INVITED') return { key: 'NOT_ACTIVATED', reasons: ['Has not activated the account yet'] };
  if (profile.status !== 'ACTIVE') return null; // disabled / archived people are not "ready" or "not ready"

  const mandatory = learning.filter((l) => l.course && l.course.mandatory);
  const openMandatory = mandatory.filter((l) => l.status !== 'COMPLETED');
  const attention = [];
  if (setup.overdueCount > 0) attention.push(`${setup.overdueCount} setup item${setup.overdueCount === 1 ? '' : 's'} overdue`);
  if (setup.hasIssue) attention.push('A setup item has an issue');
  const overdue = learning.filter((l) => l.overdue).length;
  if (overdue) attention.push(`${overdue} training assignment${overdue === 1 ? '' : 's'} overdue`);
  const retakes = learning.filter((l) => l.retake).length;
  if (retakes) attention.push(`${retakes} retake${retakes === 1 ? '' : 's'} required`);
  if (attention.length) return { key: 'NEEDS_ATTENTION', reasons: attention };
  if (!setup.fullySetUp) return { key: 'SETUP_REQUIRED', reasons: [`${setup.required - setup.completed} required setup item${setup.required - setup.completed === 1 ? '' : 's'} left`] };
  if (openMandatory.length) return { key: 'TRAINING_REQUIRED', reasons: [`${openMandatory.length} mandatory training${openMandatory.length === 1 ? '' : 's'} not completed`] };
  return { key: 'READY', reasons: [] };
}

/**
 * Readiness for many profiles of ONE organization. `setupMap` may be passed when the caller already loaded it.
 * Returns Map(profileId -> { key, label, tone, reasons }) (people who are disabled or archived have no entry).
 */
async function readinessFor(organizationId, profiles, { setupMap = null, now = new Date() } = {}) {
  const setups = setupMap || await loadSetupForProfiles(organizationId, profiles);
  const active = profiles.filter((p) => p.status === 'ACTIVE');
  const learning = active.length ? await loadLearning(active.map((p) => p.id), now) : [];
  const out = new Map();
  for (const profile of profiles) {
    const setup = setups.get(profile.id);
    const result = setup && decide({ profile, setup, learning: learning.filter((l) => l.profileId === profile.id) });
    if (result) out.set(profile.id, { ...result, label: STATUS[result.key].label, tone: STATUS[result.key].tone });
  }
  return out;
}

module.exports = { STATUS, KEYS, decide, readinessFor };
