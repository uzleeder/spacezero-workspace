'use strict';

// Employees & Teams -> New agents (lib/newAgentBoard.js): the supervisor's board of their agents in the New Agent
// Program, and one agent's page, day by day. A Supervisor sees and acts on their own agents; an Admin on everyone's.
// The supervisor ticks what only they can do (demos, check-ins, sign-offs, reviews, an agent's task they saw done),
// sets the agent's working days and days off, extends a week, and keeps notes. Everything else ticks itself.
// A new Travel Agent in their ramp is approved for solo live calls here, by an Admin (who may approve anyway, with a
// reason, or extend the ramp at its end). A supervisor's sign-off of a Travel Agent waits for an Admin to confirm it;
// an Admin's "Waiting for you" page (/new-agents/approvals) has the approvals, the sign-offs and the flags.
const router = require('express').Router();
const { prisma } = require('../lib/prisma');
const { requireRole } = require('../lib/authMiddleware');
const { canViewProfile } = require('../lib/authz');
const { roleLabel } = require('../lib/roles');
const board = require('../lib/newAgentBoard');
const plans = require('../lib/newAgentPlan');
const np = require('../lib/newAgentProgram');

const managers = requireRole('ADMIN', 'SUPERVISOR');
const notFound = (res) => res.status(404).render('not-found', { layout: false });

/** The program of an agent this viewer may manage (their own agent, or anyone for an Admin), or null. */
async function programFor(req, profileId) {
  if (profileId === req.profile.id || !await canViewProfile(req.profile, profileId)) return null;
  return prisma.agentProgram.findUnique({ where: { profileId } });
}

// the agent page's tabs (?tab=), and the tab each part of the page is on
const TABS = ['plan', 'ready', 'notes', 'days'];
const TAB_OF = { ready: 'ready', signoffs: 'ready', calls: 'ready', notes: 'notes', 'working-days': 'days' };

/** Back to where the action was taken: the board at the agent's line, or the agent's page at that item, on its tab. */
function back(req, res, program, { error = '', anchor = '' } = {}) {
  const board = req.body.from === 'board';
  const approvals = req.body.from === 'approvals';
  const base = board ? '/new-agents' : approvals ? '/new-agents/approvals' : `/new-agents/${program.profileId}`;
  const at = board || approvals ? `agent-${program.profileId}` : anchor;
  const query = [board || approvals ? '' : `tab=${TAB_OF[anchor] || 'plan'}`, error ? `error=${encodeURIComponent(error)}` : ''].filter(Boolean).join('&');
  res.redirect(`${base}${query ? `?${query}` : ''}${at ? `#${at}` : ''}`);
}

router.get('/new-agents', managers, async (req, res) => {
  const supervisorId = req.profile.role === 'ADMIN' && typeof req.query.supervisor === 'string' ? req.query.supervisor : '';
  const data = await board.boardFor(req.profile, { supervisorId, group: typeof req.query.group === 'string' ? req.query.group : '' });
  res.set('Cache-Control', 'private, no-store');
  res.render('new-agents/index', {
    title: 'New agents', ...data, supervisorId, isAdmin: req.profile.role === 'ADMIN', roleLabel, board, np, plans, KINDS: plans.KINDS,
    error: typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : '',
  });
});

router.get('/new-agents/approvals', requireRole('ADMIN'), async (req, res) => {
  const data = await board.approvalsFor(req.profile);
  res.set('Cache-Control', 'private, no-store');
  res.render('new-agents/approvals', { title: 'Waiting for you · New agents', ...data, board, roleLabel, error: typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : '' });
});

router.get('/new-agents/:id', managers, async (req, res) => {
  const program = await programFor(req, req.params.id);
  if (!program) return notFound(res);
  const state = await board.agentState(program.id, req.profile);
  const notes = await board.notesFor(state);
  const doers = [...new Set(state.tasks.flatMap((t) => [t.doneById, t.requestedById]).filter(Boolean))];
  const names = new Map((doers.length ? await prisma.profile.findMany({ where: { id: { in: doers } }, select: { id: true, fullName: true } }) : []).map((p) => [p.id, p.fullName]));
  res.set('Cache-Control', 'private, no-store');
  res.render('new-agents/agent', {
    title: `${state.profile.fullName} · New agent`, a: state, notes, names, roleLabel, board, np, plans, KINDS: plans.KINDS, VERDICTS: board.VERDICTS,
    workDays: np.cleanWorkDays(JSON.parse(program.workDaysJson || '[]')), daysOff: JSON.parse(program.daysOffJson || '[]'), WEEKDAY_NAMES: np.WEEKDAY_NAMES,
    active: program.status === 'ACTIVE', error: typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : '',
    tab: TABS.includes(req.query.tab) ? req.query.tab : 'plan',
  });
});

/** The running program and one of its tasks, or a 404. */
async function taskFor(req, res) {
  const program = await programFor(req, req.params.id);
  const task = program && program.status === 'ACTIVE' ? await prisma.agentProgramTask.findFirst({ where: { id: req.params.taskId, programId: program.id } }) : null;
  if (!task) { notFound(res); return null; }
  return { program, task };
}

router.post('/new-agents/:id/tasks/:taskId/done', managers, async (req, res) => {
  const found = await taskFor(req, res);
  if (!found) return;
  const error = await board.completeTask(req.profile, found.program, found.task, { note: req.body.note, verdict: req.body.verdict });
  back(req, res, found.program, { error, anchor: `task-${found.task.id}` });
});

router.post('/new-agents/:id/tasks/:taskId/undo', managers, async (req, res) => {
  const found = await taskFor(req, res);
  if (!found) return;
  const error = await board.undoTask(req.profile, found.program, found.task);
  back(req, res, found.program, { error, anchor: `task-${found.task.id}` });
});

// an Admin's checks on a new Travel Agent's item (lib/newAgentBoard.js): confirm or send back a sign-off, let a flag be
router.post('/new-agents/:id/tasks/:taskId/confirm', managers, async (req, res) => {
  const found = await taskFor(req, res);
  if (!found) return;
  const error = await board.confirmSignOff(req.profile, found.program, found.task);
  back(req, res, found.program, { error, anchor: `task-${found.task.id}` });
});

router.post('/new-agents/:id/tasks/:taskId/send-back', managers, async (req, res) => {
  const found = await taskFor(req, res);
  if (!found) return;
  const error = await board.sendBack(req.profile, found.program, found.task, req.body.reason);
  back(req, res, found.program, { error, anchor: `task-${found.task.id}` });
});

router.post('/new-agents/:id/tasks/:taskId/clear-flag', managers, async (req, res) => {
  const found = await taskFor(req, res);
  if (!found) return;
  const error = await board.clearFlag(req.profile, found.program, found.task);
  back(req, res, found.program, { error, anchor: `task-${found.task.id}` });
});

/** The running program for the agent-level actions below, or a 404. */
async function runningFor(req, res) {
  const program = await programFor(req, req.params.id);
  if (!program || program.status !== 'ACTIVE') { notFound(res); return null; }
  return program;
}

router.post('/new-agents/:id/extend', managers, async (req, res) => {
  const program = await runningFor(req, res);
  if (!program) return;
  await board.extend(req.profile, program);
  back(req, res, program);
});

router.post('/new-agents/:id/working-days', managers, async (req, res) => {
  const program = await runningFor(req, res);
  if (!program) return;
  const error = await board.setWorkDays(req.profile, program, req.body.days == null ? [] : req.body.days);
  back(req, res, program, { error, anchor: 'working-days' });
});

router.post('/new-agents/:id/days-off', managers, async (req, res) => {
  const program = await runningFor(req, res);
  if (!program) return;
  const error = await board.setDayOff(req.profile, program, req.body.date, req.body.remove !== '1');
  back(req, res, program, { error, anchor: 'working-days' });
});

router.post('/new-agents/:id/approve', managers, async (req, res) => {
  const program = await runningFor(req, res);
  if (!program) return;
  const state = await board.agentState(program.id, req.profile);
  const error = await board.approve(req.profile, state, { anyway: req.body.anyway === '1', reason: req.body.reason });
  back(req, res, program, { error, anchor: 'ready' });
});

router.post('/new-agents/:id/not-yet', managers, async (req, res) => {
  const program = await runningFor(req, res);
  if (!program) return;
  const error = await board.notYet(req.profile, await board.agentState(program.id, req.profile), req.body.reason);
  back(req, res, program, { error, anchor: 'ready' });
});

router.post('/new-agents/:id/extend-ramp', managers, async (req, res) => {
  const program = await runningFor(req, res);
  if (!program) return;
  const error = await board.extendRamp(req.profile, await board.agentState(program.id, req.profile));
  back(req, res, program, { error, anchor: 'ready' });
});

router.post('/new-agents/:id/notes', managers, async (req, res) => {
  const program = await runningFor(req, res);
  if (!program) return;
  const error = await board.addNote(req.profile, program, req.body.body);
  back(req, res, program, { error, anchor: 'notes' });
});

module.exports = router;
