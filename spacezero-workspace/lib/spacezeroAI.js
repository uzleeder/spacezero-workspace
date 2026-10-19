'use strict';

// SpaceZero AI — a read-only assistant that answers questions using information ALREADY inside
// SpaceZero, never a general-purpose chatbot. The flow is always:
//   USER QUESTION -> AUTHORIZATION -> SAFE INTERNAL DATA RETRIEVAL -> MINIMUM NECESSARY CONTEXT -> AI -> RESPONSE
// Authorization happens BEFORE any data is gathered: `scopedProfiles()` (reused unchanged from
// lib/attention.js, the same boundary that already drives every role's Dashboard) decides WHO the
// facts bundle may ever mention. Gemini never sees anyone outside that scope, and this module
// never imports lib/credentialCrypto.js or queries the Credential/CredentialGrant tables — there
// is no code path from here to the vault, tokens or password hashes.
const { z } = require('zod');
const { Type } = require('@google/genai');
// Called as gemini.generateStructured(...) below (never destructured) so tests can mock.method()
// this module's export and have it actually take effect at call time.
const gemini = require('./gemini');
const { logAudit } = require('./audit');
const { scopedProfiles } = require('./attention');
const { loadSetupForProfiles } = require('./employeeSetup');
const { loadLearning } = require('./teamIntel');
const { ackSummaryForProfiles } = require('./standards');
const { getSkillGraph } = require('./skills');
const { passportStatus } = require('./passport');

const PROMPT_VERSION = 'assistant.answer@1';

const AnswerZodSchema = z.object({
  answer: z.string().min(1).max(2000),
  confident: z.boolean(),
});
const AnswerGeminiSchema = {
  type: Type.OBJECT,
  properties: {
    answer: { type: Type.STRING, description: 'The answer, 2-6 sentences or a short bullet list. Plain text only.' },
    confident: { type: Type.BOOLEAN, description: 'true only if the provided FACTS actually contain enough to answer; false otherwise.' },
  },
  required: ['answer', 'confident'],
};

const SYSTEM_INSTRUCTION = `You are SpaceZero AI, a read-only assistant built into the SpaceZero Workspace internal staff system.
Answer ONLY using the FACTS JSON provided in this request. Never use outside/general knowledge, never invent employee names,
numbers or statuses that are not present in FACTS. If FACTS does not contain enough information to answer the question
confidently, set confident=false and say plainly that you could not find enough SpaceZero data to answer — do not guess.
Never make a subjective character judgement about a person (e.g. "good", "bad", "lazy", "weak performer", "underperforming").
State objective facts and counts only (e.g. "2 required items overdue", "retake required for X"), matching the FACTS given.
Keep the answer concise. When useful, name the specific item (a setup item, a training title) exactly as it appears in FACTS.
For any TOTAL or COUNT, always use the numbers already given in FACTS.summary — do not recompute or re-derive a total by
counting FACTS.people yourself. FACTS.summary.invitedNotYetActivatedCount are people who have not accepted their invitation
yet; they have no setup progress to report and must never be described as "needing setup" or having an "issue" — mention
them only if the question is specifically about activation/invitations. FACTS.people is for naming specific individuals and
their specific items only. FACTS never contains an actual Passport Number and never will — if asked for one, say plainly
that Passport Numbers cannot be shown here, even if FACTS.summary.passportExpiringOrExpiredCount is present. You cannot
take any action — you can only describe what is already recorded in SpaceZero.`;

/**
 * Authorization-scoped facts bundle. Mirrors exactly what the Dashboard "Needs your attention"
 * card already shows this same actor — nothing here is a second source of truth, and nothing
 * here is outside what `scopedProfiles()` already decided the actor may see.
 */
async function buildFacts(actor) {
  // scopedProfiles() (lib/attention.js) is the Admin/Supervisor management-scope function — for
  // anyone else (an ordinary employee, who manages no one) it correctly returns nobody, since it
  // was written for the "manage my team" surfaces. An employee's own question is answered from
  // just their own record instead, the same split lib/attention.js#attentionFor already makes
  // between managementItems() and employeeItems().
  const withSelf = actor.role === 'ADMIN' || actor.role === 'SUPERVISOR' ? await scopedProfiles(actor) : [actor];
  // Setup/training/retake/standards facts are computed for ACTIVE people only — an invited
  // person who has not activated their account yet cannot have "unfinished setup" in any
  // meaningful sense, and counting them would make the numbers disagree with the Dashboard's
  // own "Needs your attention" figures (lib/attention.js#managementItems uses this exact same
  // `active` filter for the same reason).
  const active = withSelf.filter((p) => p.status === 'ACTIVE');
  const invited = withSelf.filter((p) => p.status === 'INVITED');
  const now = new Date();

  const [setups, learning, acks] = await Promise.all([
    loadSetupForProfiles(actor.organizationId, active),
    active.length ? loadLearning(active.map((p) => p.id), now) : [],
    active.length ? ackSummaryForProfiles(actor.organizationId, active) : new Map(),
  ]);

  const people = await Promise.all(active.map(async (p) => {
    const setup = setups.get(p.id);
    const myLearning = learning.filter((l) => l.profileId === p.id);
    const ack = acks.get(p.id);
    const hasSkillGraph = p.role === 'TRAVEL_AGENT' || p.role === 'FLIGHT_EXPERT';
    const skills = hasSkillGraph ? await getSkillGraph(p.id) : [];
    return {
      name: p.fullName,
      role: p.role,
      setupPercent: setup.percent,
      setupFullyDone: setup.fullySetUp,
      setupOverdueItemCount: setup.overdueCount,
      setupIssues: setup.rows.filter((r) => r.status === 'ISSUE').map((r) => ({ item: r.requirement.label, note: r.item && r.item.note ? r.item.note : null })),
      trainingOverdue: myLearning.filter((l) => l.overdue).map((l) => l.course.title),
      retakeRequired: myLearning.filter((l) => l.retake).map((l) => l.course.title),
      skillsAvgPercent: skills.length ? Math.round(skills.reduce((s, x) => s + x.currentScore, 0) / skills.length) : null,
      standardsPending: ack ? ack.pending : 0,
    };
  }));

  // Pre-aggregated, authoritative counts — the SAME numbers the Dashboard's "Needs your
  // attention" card computes. Gemini is told to prefer these over re-deriving totals itself from
  // the per-person list, which is what caused an earlier version of this feature to answer a
  // technically-true-but-misleading count (it does not know an invited person's 0% is not "needs
  // setup work" unless we exclude them here rather than asking the model to figure that out).
  const summary = {
    activeEmployeesInScope: active.length,
    invitedNotYetActivatedCount: invited.length,
    invitedNotYetActivatedNames: invited.map((p) => p.name),
    needingSetupCount: people.filter((p) => !p.setupFullyDone).length,
    setupIssueCount: people.filter((p) => p.setupIssues.length > 0).length,
    overdueTrainingCount: people.filter((p) => p.trainingOverdue.length > 0).length,
    retakeRequiredCount: people.filter((p) => p.retakeRequired.length > 0).length,
    standardsPendingCount: people.filter((p) => p.standardsPending > 0).length,
    // A count only — never a name, never a number. passportStatus() reads the plaintext expiration
    // date alone; this module never imports lib/passport.js's decrypt function or touches
    // passportNumberEnc, so there is no code path from here to an actual Passport Number.
    passportExpiringOrExpiredCount: active.filter((p) => { const s = passportStatus(p.passportExpiresAt, now); return s === 'EXPIRING_SOON' || s === 'EXPIRED'; }).length,
  };

  return { asOfDate: now.toISOString().slice(0, 10), viewerRole: actor.role, summary, people };
}

// Fixed, safe navigation links shown alongside every answer — never model-generated (a Gemini
// response never contains a URL SpaceZero treats as trusted), so there is no path to a
// hallucinated or unsafe link.
function quickLinksFor(role) {
  if (role === 'ADMIN') {
    return [
      { label: 'Employees & Teams', href: '/admin/employees' },
      { label: 'Training', href: '/admin/training' },
      { label: 'Standards — team status', href: '/standards/team-status' },
      { label: 'Vacation requests', href: '/leave' },
    ];
  }
  if (role === 'SUPERVISOR') {
    return [
      { label: 'My Team', href: '/team' },
      { label: 'Training', href: '/admin/training' },
      { label: 'Standards — team status', href: '/standards/team-status' },
      { label: 'Vacation requests', href: '/leave' },
    ];
  }
  return [
    { label: 'My Setup', href: '/my/setup' },
    { label: 'My Training', href: '/training' },
    { label: 'Company Standards', href: '/standards' },
    { label: 'My Vacation / Leave', href: '/my/leave' },
  ];
}

const FAILSAFE = { answer: null, confident: false };

/** Never throws — a Gemini failure surfaces as a normal "not confident" result, never an error page. */
async function answerQuestion(actor, question) {
  const q = String(question || '').trim().slice(0, 500);
  if (!q) return FAILSAFE;

  const facts = await buildFacts(actor);
  let result;
  try {
    const { data } = await gemini.generateStructured({
      task: 'assistant.answer',
      promptVersion: PROMPT_VERSION,
      systemInstruction: SYSTEM_INSTRUCTION,
      contents: `FACTS (JSON — the only information you may use):\n${JSON.stringify(facts)}\n\nQUESTION:\n${q}`,
      responseSchema: AnswerGeminiSchema,
      zodSchema: AnswerZodSchema,
    });
    result = data;
  } catch {
    result = FAILSAFE;
  }

  await logAudit({
    organizationId: actor.organizationId,
    actorId: actor.id,
    action: 'assistant.question_asked',
    targetTable: 'Profile',
    targetId: actor.id,
    metadata: { questionPreview: q.slice(0, 120), confident: Boolean(result.confident), peopleCount: facts.people.length },
  });

  return result;
}

module.exports = { answerQuestion, buildFacts, quickLinksFor };
