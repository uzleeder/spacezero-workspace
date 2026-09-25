'use strict';

// "Needs your attention" — the actionable part of the existing Dashboard. Every number is computed on the
// server inside the viewer's own scope and links to the place where the work is done:
//   Admin      the whole organization        Supervisor  their own assigned team        Employee  their own actions
// Only things that need doing are listed; when there is nothing, the dashboard says so.
const { prisma } = require('./prisma');
const { supervisedProfileIds } = require('./authz');
const { excludeOtherAdminsTestProfiles } = require('./loginAsScope');
const { loadSetupForProfiles } = require('./employeeSetup');
const { loadLearning } = require('./teamIntel');
const { visibleLeaveWhere } = require('./leave');

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

async function scopedProfiles(actor) {
  if (actor.role === 'ADMIN') {
    return prisma.profile.findMany({ where: { organizationId: actor.organizationId, status: { in: ['ACTIVE', 'INVITED'] }, id: { not: actor.id }, ...excludeOtherAdminsTestProfiles(actor) } });
  }
  const ids = await supervisedProfileIds(actor.id);
  return prisma.profile.findMany({ where: { id: { in: ids }, organizationId: actor.organizationId, status: { in: ['ACTIVE', 'INVITED'] } } });
}

/** People-management view (Admin / Supervisor). */
async function managementItems(actor, now) {
  const profiles = await scopedProfiles(actor);
  const active = profiles.filter((p) => p.status === 'ACTIVE');
  const setups = await loadSetupForProfiles(actor.organizationId, profiles);
  const learning = active.length ? await loadLearning(active.map((p) => p.id), now) : [];
  const base = actor.role === 'ADMIN' ? '/admin/employees' : '/team';

  const needingSetup = active.filter((p) => !setups.get(p.id).fullySetUp).length;
  const overdueSetup = active.reduce((n, p) => n + setups.get(p.id).overdueCount, 0);
  const overdueSetupPeople = active.filter((p) => setups.get(p.id).overdueCount > 0).length;
  const pendingActivation = profiles.filter((p) => p.status === 'INVITED').length;
  const mandatoryOverdue = learning.filter((l) => l.overdue && l.course && l.course.mandatory);
  const retakes = learning.filter((l) => l.retake);
  const pendingLeave = await prisma.leaveRequest.count({ where: { ...(await visibleLeaveWhere(actor)), status: 'PENDING' } });

  const items = [
    { key: 'setup', label: 'Employees needing setup', value: needingSetup, href: `${base}?readiness=SETUP_REQUIRED`, hint: 'Required setup is not finished' },
    { key: 'setupOverdue', label: 'Overdue setup items', value: overdueSetup, href: `${base}?readiness=NEEDS_ATTENTION`, hint: `${plural(overdueSetupPeople, 'employee', 'employees')} — owner and due date are on each employee's setup`, tone: 'danger' },
    { key: 'activation', label: 'Pending profile activation', value: pendingActivation, href: `${base}?readiness=NOT_ACTIVATED`, hint: 'Invited, not activated yet' },
    { key: 'trainingOverdue', label: 'Mandatory training overdue', value: new Set(mandatoryOverdue.map((l) => l.profileId)).size, href: `${base}?overdue=1`, hint: `${plural(mandatoryOverdue.length, 'assignment', 'assignments')} past due`, tone: 'danger' },
    { key: 'retake', label: 'Retake required', value: new Set(retakes.map((l) => l.profileId)).size, href: `${base}?retake=1`, hint: `${plural(retakes.length, 'training', 'trainings')} below the pass mark`, tone: 'danger' },
    { key: 'leave', label: 'Pending vacation requests', value: pendingLeave, href: '/leave?status=PENDING', hint: 'Awaiting a decision' },
  ];

  if (actor.role === 'ADMIN') {
    const { loadSources } = require('./aiPracticeState');
    const review = (await loadSources(actor, { now })).filter((i) => ['ANALYSIS_READY', 'PRACTICE_DRAFT', 'READY_FOR_REVIEW', 'FAILED'].includes(i.state.key)).length;
    items.push({ key: 'ai', label: 'AI Practice ready for review', value: review, href: '/ai-practice?tab=review', hint: 'Analysis or practice waiting for you' });
  }
  return items;
}

/** The employee's own actions. */
async function employeeItems(actor, now) {
  const setup = (await loadSetupForProfiles(actor.organizationId, [actor])).get(actor.id);
  const learning = await loadLearning([actor.id], now);
  const mandatoryOpen = learning.filter((l) => l.course && l.course.mandatory && l.status !== 'COMPLETED');
  const overdue = learning.filter((l) => l.overdue);
  const retakes = learning.filter((l) => l.retake);
  return [
    { key: 'mySetup', label: 'Setup items to complete', value: setup.notStarted ? 0 : setup.required - setup.completed, href: '/my/setup', hint: setup.overdueCount ? `${plural(setup.overdueCount, 'is', 'are')} overdue` : 'See owner and due date on each item', tone: setup.overdueCount ? 'danger' : undefined },
    { key: 'myOverdue', label: 'Training overdue', value: overdue.length, href: '/training', hint: 'Past its due date', tone: 'danger' },
    { key: 'myRetake', label: 'Retake required', value: retakes.length, href: '/training', hint: 'Below the pass mark', tone: 'danger' },
    { key: 'myMandatory', label: 'Mandatory training to do', value: mandatoryOpen.length, href: '/training', hint: 'Not completed yet' },
  ];
}

/** { items: [only the ones with something to do], total } */
async function attentionFor(actor, { now = new Date() } = {}) {
  const all = actor.role === 'ADMIN' || actor.role === 'SUPERVISOR' ? await managementItems(actor, now) : await employeeItems(actor, now);
  const items = all.filter((i) => i.value > 0);
  return { items, total: items.reduce((n, i) => n + i.value, 0) };
}

module.exports = { attentionFor };
