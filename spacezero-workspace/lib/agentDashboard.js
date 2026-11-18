'use strict';

// The Agent dashboard ("what do I do next?", approved 2026-11-04). The same page for every agent, new or not; each
// part shows only while it has something to do:
//   Next           the current step of My Training (lib/myTraining.js pathOf: the same step and the same button);
//                  with nothing left there, the practice Skill DNA suggests (lib/development.js nextActions)
//   Call Practice  only while a call is waiting today (lib/callPractice.js summaryFor); gone when today's calls are
//                  done, every call is done, or Call Practice is over for them
//   Also for you   setup left, required standards to read, other overdue trainings and retakes
// Everything is counted live, per request, from the same functions My Training, Setup and Standards use.
const { getMyTrainingList } = require('./training');
const { pathOf, overdueText, dueText } = require('./myTraining');
const { loadSetupForProfile } = require('./employeeSetup');
const { ackSummaryForProfile } = require('./standards');
const { summaryFor } = require('./callPractice');
const { nextActions } = require('./development');

const SUGGESTED = ['SKILL_GAP', 'DECLINING', 'LOW_CONFIDENCE']; // Skill DNA's own practice suggestions (lib/development.js)

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The 2 chips under the next training: where it is in the path, then how it stands (overdue / retake / started / due). */
function chipsOf(step, total, now) {
  const chips = [{ text: `Training ${step.number} of ${total}`, tone: 'plain' }];
  const items = step.row.progress && step.row.progress.items;
  if (step.retake) chips.push({ text: 'Retake needed', tone: 'red' });
  else if (step.overdue) chips.push({ text: overdueText(step.dueDate, now), tone: 'red' });
  else if (step.started && items && items.total) chips.push({ text: `${Math.round((items.done / items.total) * 100)}% done`, tone: 'gold' });
  else if (step.dueDate) chips.push({ text: dueText(step.dueDate, now), tone: 'gold' });
  return chips;
}

/** Everything the Agent dashboard shows, counted now. */
async function agentDashboard(profile, { now = new Date() } = {}) {
  const [list, plan, setup, ack] = await Promise.all([
    getMyTrainingList(profile.id, { progress: true }),
    summaryFor(profile),
    loadSetupForProfile(profile.organizationId, profile),
    ackSummaryForProfile(profile.organizationId, profile),
  ]);
  const path = pathOf(list, now);
  const step = path.current;
  let next = step ? { label: 'Next', title: step.title, href: step.href, action: path.action, chips: chipsOf(step, path.total, now) } : null;
  // nothing left on My Training: the practice their Skill DNA suggests for a weak or slipping skill, if there is one
  if (!next) {
    const s = (await nextActions(profile)).next;
    if (s && SUGGESTED.includes(s.kind) && s.action && s.action.href) {
      next = { label: 'Suggested practice', title: s.title, href: s.action.href, action: s.action.label, chips: [s.skill ? { text: `${s.skill.name} ${s.skill.score}%`, tone: 'gold' } : null, s.estimatedMinutes ? { text: `${s.estimatedMinutes} min`, tone: 'plain' } : null].filter(Boolean) };
    }
  }

  // Call Practice: only when a call can be done now
  const call = plan && plan.next && plan.open ? {
    title: `Call ${plan.next.number} is ${plan.started ? 'in progress' : 'ready'}`,
    meta: `Listen and type what you hear. About ${plural(Math.max(1, Math.round((plan.next.call.durationSeconds || 60) / 60)), 'minute')}.`,
    action: plan.started ? 'Continue' : 'Start call', href: `/call-practice/${plan.next.call.id}`,
  } : null;

  const also = [];
  const left = setup.notStarted ? 0 : setup.rows.filter((r) => r.counts && r.status !== 'COMPLETED' && !r.awaitingVerification).length;
  if (left) also.push({ key: 'setup', icon: 'lock', label: 'Finish your setup', chip: `${left} left`, tone: setup.overdueCount ? 'red' : 'gold', href: '/my/setup' });
  if (ack.pending) also.push({ key: 'standards', icon: 'book', label: ack.pending === 1 ? `Read "${ack.pendingTitles[0]}"` : `Read ${ack.pending} standards`, chip: 'Required', tone: 'gold', href: '/standards' });
  const others = path.steps.filter((s) => !s.done && s !== step);
  const retakes = others.filter((s) => s.retake);
  const overdue = others.filter((s) => s.overdue && !s.retake);
  if (retakes.length) also.push({ key: 'retakes', icon: 'redo', label: retakes.length === 1 ? `Retake "${retakes[0].title}"` : `${retakes.length} retakes`, chip: 'Retake', tone: 'red', href: retakes.length === 1 ? retakes[0].href : '/training' });
  if (overdue.length) also.push({ key: 'overdue', icon: 'clock', label: overdue.length === 1 ? `"${overdue[0].title}"` : `${overdue.length} more trainings`, chip: 'Overdue', tone: 'red', href: '/training' });

  const lateCount = (step && (step.overdue || step.retake) ? 1 : 0) + retakes.length + overdue.length;
  const headline = !next && !call && !also.length ? 'All caught up.' : lateCount ? `${plural(lateCount, 'thing is', 'things are')} overdue.` : '';
  return { next, call, also, progress: { done: path.doneCount, total: path.total, percent: path.percent }, headline, at: now };
}

module.exports = { agentDashboard, chipsOf };
