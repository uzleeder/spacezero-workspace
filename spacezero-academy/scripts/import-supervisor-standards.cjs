'use strict';
// One-time CONTENT import for Company Standards & Workflow: the Supervisor Responsibilities and the
// Supervisor Daily & Team Management Workflow.
//
// This writes ordinary rows into the EXISTING Standards tables (StandardsItem / StandardsVersion /
// StandardsResponsibilityItem / StandardsStep) — exactly what Settings → Standards (Admin UI) writes.
// Nothing here is read by the application at runtime: after the import the text lives in the database
// and is edited, revised, versioned, published and archived from the Admin UI like any other item.
//
//   node scripts/import-supervisor-standards.cjs                  # real run (DATABASE_URL decides which DB)
//   node scripts/import-supervisor-standards.cjs --dry            # show what would happen, write nothing
//   node scripts/import-supervisor-standards.cjs --email a@b.com  # which Admin is recorded as author/publisher
//
// Safe to run again: an existing item with the same type + title is UPDATED (a new published version,
// the old one archived, history kept) and only if its content actually differs; nothing is duplicated.
// It never touches other items, acknowledgements, permissions or any business rule.
const { prisma } = require('../lib/prisma');
const { logAudit } = require('../lib/audit');
const { blocksToJson, parseBlocks } = require('../lib/richContent');

const AUDIENCE = ['SUPERVISOR'];

// Limits enforced by the Admin form (routes/admin/standards.js). Staying inside them means an Admin
// can open, edit and save these documents without anything being cut off.
const LIMITS = { title: 140, category: 60, shortDescription: 300, responsibility: 500, stepTitle: 140, stepInstruction: 1000, stepExplanation: 2000, checklistLine: 500, note: 500, maxResponsibilities: 60, maxChecklist: 20, block: 4000 };

// ---------------------------------------------------------------------------------------------
// DOCUMENT 1 — Supervisor Responsibilities (type RESPONSIBILITY)
// ---------------------------------------------------------------------------------------------
const RESPONSIBILITIES = {
  contentType: 'RESPONSIBILITY',
  title: 'Supervisor Responsibilities',
  category: 'Supervisor',
  shortDescription: 'Defines the responsibilities of Supervisors for team leadership, employee development, call quality, operational readiness, training, performance improvement, ticketing support and professional standards.',
  requiredReading: true,
  items: [
    '**Purpose.** A Supervisor is responsible for the readiness, performance, development and day-to-day support of the employees assigned to their team. The role is not simply to monitor employees. The management principle: **Observe → Identify → Coach → Support → Verify Improvement → Escalate When Necessary.**',
    '**1. Team leadership.** Manage the assigned team day to day and keep awareness of attendance, punctuality, workflow, operational readiness, communication, performance, training needs, professional conduct and client-service quality. Identify problems early rather than waiting for serious performance issues.',
    '**2. Call monitoring & sales quality.** Regularly listen to and review Agent calls. Pay attention to the first-call opening, discovery, listening, confidence, presentation, client engagement, objection handling, value explanation, closing attempts, follow-up commitments, professional conduct and accuracy. When weaknesses are identified, coach the Agent and later verify improvement.',
    '**3. First-call development.** Train Agents to make the first client interaction productive: ask appropriate discovery questions, understand the client\'s priorities, keep professional confidence, present value, handle objections, keep the client engaged, establish a clear next action and work toward commitment where appropriate. The objective is quality and effectiveness, not simply keeping the client on the phone longer.',
    '**4. Training responsibility.** Supervisors are responsible for continuous team development. At minimum, conduct or coordinate **at least ONE meaningful team training per week**. Training should address real development needs rather than being done only to satisfy a requirement.',
    '**Possible training topics.** Airline/product knowledge, GDS, professional flight searching, fares, ticketing, first-call closing, client engagement, objection handling, sales technique, CRM, UMS, company systems, follow-up, recurring call mistakes, workflow problems and other identified team needs.',
    '**5. Training collaboration with Management.** Communicate regularly with Management about training needs: suggest topics, request Management coaching, receive training from Management, help prepare material, contribute examples from real calls/cases, help deliver training and recommend improvements to existing training. Keep developing your own professional knowledge.',
    '**6. Underperformance & individual coaching.** When an Agent underperforms, investigate WHY: call quality, sales technique, product/GDS/fare knowledge, CRM activity, follow-up, Setup, system access, UMS, communication, workflow understanding, training history and technical problems. Then: identify the problem → coach / train / support → follow up → verify improvement.',
    '**7. Employee Setup & operational readiness.** Make sure the team has the tools it needs: email, WhatsApp/company communication, UMS, CRM, GDS, flight/booking tools and other applicable company systems. The authoritative Setup status stays in SpaceZero Setup — do not keep another Setup checklist here.',
    '**8. CRM quality.** Monitor whether Agents use the CRM correctly: lead status, comments, follow-up activity, appointments, client preferences, pending actions and general CRM discipline. Poor CRM usage should be considered when investigating weak performance.',
    '**9. GDS & flight knowledge.** Keep enough professional GDS and flight-search knowledge to coach Agents: availability, routes, booking classes and booking codes, fare classes, airline options, schedule considerations, connection options, product differences and explaining the options to clients.',
    '**10. Fare rules, exchanges & ticketing.** Keep enough ticketing and fare-rule knowledge to support Agents: changes, cancellations, refunds, penalties, fare restrictions, ticket validity, booking-class restrictions, exchange/reissue, fare differences and airline-specific conditions.',
    '**Important — verify before advising.** Before giving fare-rule, exchange or ticketing advice, verify the applicable information — do not rely only on memory. If it is unclear or outside your knowledge or authority, escalate to the appropriate Flight Expert, Product Manager, Manager or authorized ticketing specialist.',
    '**11. Product knowledge.** Continuously improve your knowledge of airline products, company products, fare products, ticketing procedures, operational tools and relevant new processes. Discuss important knowledge gaps with Management and turn them into training where appropriate.',
    '**12. Company standards.** Reinforce the Company Standards, role Responsibilities, approved Workflows, professional conduct and client-service expectations. Address recurring issues through coaching, training or escalation.',
    '**13. Operational support.** Support difficult operational situations — urgent airport situations, rush tickets, difficult client situations, ticketing uncertainty, complicated sales cases, system/workflow questions and operational problems. Guide within your authority and escalate when specialist involvement is required.',
    '**14. Management communication.** Keep Management informed about significant performance problems, training needs, operational issues, technical problems, recurring mistakes, product knowledge gaps, client-service concerns and improvement opportunities. Material problems must not be intentionally hidden or unnecessarily delayed.',
    '**15. Handover & continuity.** Important unresolved situations need clear ownership. When responsibility changes between shifts, Supervisors or Managers, make sure important cases are properly handed over.',
    '**16. Weekend Supervisor availability.** Space Zero may run a rotating weekend Supervisor availability schedule. The assigned weekend Supervisor is not expected to sit at a computer as in a normal full shift, but during assigned coverage should reasonably remain reachable, have internet access, monitor important messages, be able to receive/return urgent calls, keep reasonable system access and provide emergency guidance.',
    '**Weekend coverage scope.** Weekend coverage includes assisting employees across the office, not only your own team — for example an urgent airport case, a rush ticket, an urgent operational issue or an Agent who needs immediate Supervisor guidance. The exact rotation, coverage period, expected response time and scheduling details remain subject to Management instructions.',
    '**17. Continuous improvement.** Actively look for ways to improve training, sales, communication, client service, workflow, product knowledge and operational quality. Discuss useful improvement ideas with Management.',
    '**Final principle:** Observe → Identify → Coach → Support → Verify Improvement → Escalate When Necessary.',
  ],
};

// ---------------------------------------------------------------------------------------------
// DOCUMENT 2 — Supervisor Daily & Team Management Workflow (type WORKFLOW)
// ---------------------------------------------------------------------------------------------
const step = (title, instruction, extra = {}) => ({ title, instruction, ...extra });
const WORKFLOW = {
  contentType: 'WORKFLOW',
  title: 'Supervisor — Daily Team Management & Development Workflow',
  category: 'Supervisor',
  shortDescription: 'Defines the practical daily and weekly workflow Supervisors use to monitor team readiness, calls, CRM, performance, coaching, training, escalation and operational continuity.',
  requiredReading: false,
  steps: [
    step('Start of shift — Review team status', 'At the beginning of the working period, review important team conditions.', { explanation: 'Where relevant:', checklist: ['Attendance', 'Unexpected absence', 'Important unresolved cases', 'Urgent client situations', 'Setup/access problems', 'Significant CRM issues', 'Outstanding Management instructions'] }),
    step('Start of shift — Identify priorities', 'Determine whether any employee or client issue requires immediate attention.'),
    step('During the shift — Monitor team activity', 'Maintain reasonable awareness of how the team is operating. You do not need to interfere with every interaction.', { explanation: 'Focus especially on:', checklist: ['New / less experienced Agents', 'Difficult calls', 'Underperforming Agents', 'Unusual client cases', 'Repeated mistakes', 'Urgent cases'] }),
    step('During the shift — Listen to calls', 'Regularly monitor live or recorded Agent calls according to available systems and company rules.', { explanation: 'Evaluate:', checklist: ['Discovery', 'Communication', 'Professionalism', 'Sales technique', 'Accuracy', 'Follow-up', 'Closing'] }),
    step('During the shift — Provide fast coaching', 'If an issue can be corrected immediately, provide concise coaching. For more significant weaknesses, schedule proper coaching/training rather than interrupting repeatedly.'),
    step('During the shift — Review CRM quality', 'Periodically inspect CRM usage.', { explanation: 'Pay attention to:', checklist: ['Statuses', 'Comments', 'Appointments', 'Follow-ups', 'Unresolved leads', 'Incomplete records'] }),
    step('During the shift — Check underperformance', 'If performance declines, determine the likely cause before deciding on corrective action.', { explanation: 'Review:', checklist: ['Calls', 'CRM', 'Follow-up', 'Setup', 'UMS', 'Technical access', 'Product knowledge', 'Training history', 'GDS knowledge'] }),
    step('During the shift — Create an improvement action', 'Depending on the issue, choose the action that fits.', { checklist: ['Coach', 'Train', 'Demonstrate', 'Fix / raise technical access', 'Assign approved training', 'Request Management assistance', 'Involve Flight Expert / Product Management'] }),
    step('During the shift — Support operational questions', 'Assist Agents with workflow, ticketing questions, difficult client conversations, urgent cases, fare-rule verification and Expert escalation.', { importantNote: 'Verify information before advising on important ticketing/fare issues.' }),
    step('Training — Identify training needs', 'Training topics should come from real needs.', { explanation: 'Sources:', checklist: ['Call observations', 'Performance data', 'Agent questions', 'Recurring errors', 'Product updates', 'GDS/ticketing gaps', 'Management direction'] }),
    step('Training — Prepare training', 'Use approved material and current company information. Where needed, coordinate with Management / Flight Experts / Product Management.'),
    step('Training — Deliver or coordinate training', 'Minimum general expectation: at least ONE meaningful team training per week.'),
    step('Training — Verify the effect', 'After training, observe whether behavior/performance improves.', { warning: 'Do not treat training as complete merely because a session happened.' }),
    step('End of shift — Review important open items', 'Check whether urgent or material cases remain unresolved.'),
    step('End of shift — Handover', 'If something must continue after the Supervisor leaves, ensure clear ownership and communicate:', { checklist: ['The case', 'The employee / client', 'The issue', 'The urgency', 'Actions already taken', 'The required next action'] }),
    step('End of shift — Escalate material issues', 'Inform Management about significant unresolved matters.'),
    step('Weekly management cycle', 'At least weekly:', { checklist: ['Review team performance', 'Identify struggling Agents', 'Review training needs', 'Conduct / coordinate training', 'Discuss recurring problems', 'Review relevant Setup/readiness problems', 'Share improvement ideas with Management'] }),
    step('Weekend coverage', 'When assigned weekend coverage:', { checklist: ['Remain reasonably reachable', 'Maintain internet access', 'Monitor appropriate communication', 'Respond to urgent Supervisor-level requests', 'Support employees across the office', 'Escalate serious issues when necessary'], importantNote: 'This is emergency/operational availability, not automatically a normal full shift. Detailed scheduling remains controlled by Management.' }),
    step('Workflow principle', 'Monitor → Diagnose → Support → Develop → Verify → Handover / Escalate'),
  ],
};

const DOCUMENTS = [RESPONSIBILITIES, WORKFLOW];

/** Throws if anything would be cut off or rejected by the Admin form, so what is stored round-trips through it. */
function validate(doc) {
  const fail = (m) => { throw new Error(`${doc.title}: ${m}`); };
  if (doc.title.length > LIMITS.title) fail('title too long');
  if (doc.category.length > LIMITS.category) fail('category too long');
  if (doc.shortDescription.length > LIMITS.shortDescription) fail(`short description is ${doc.shortDescription.length} characters (max ${LIMITS.shortDescription})`);
  if (doc.items) {
    if (doc.items.length > LIMITS.maxResponsibilities) fail('too many items');
    doc.items.forEach((t, i) => { if (t.length > LIMITS.responsibility) fail(`item ${i + 1} is ${t.length} characters (max ${LIMITS.responsibility})`); });
  }
  if (doc.blocks) doc.blocks.forEach((b, i) => { if ((b.text || '').length > LIMITS.block) fail(`block ${i + 1} is longer than ${LIMITS.block} characters`); });
  if (doc.steps) {
    doc.steps.forEach((s, i) => {
      const n = i + 1;
      if (s.title.length > LIMITS.stepTitle) fail(`step ${n} title too long`);
      if (s.instruction.length > LIMITS.stepInstruction) fail(`step ${n} instruction too long`);
      if (s.explanation && s.explanation.length > LIMITS.stepExplanation) fail(`step ${n} explanation too long`);
      if (s.checklist && s.checklist.length > LIMITS.maxChecklist) fail(`step ${n} has more than ${LIMITS.maxChecklist} checklist lines`);
      if (s.importantNote && s.importantNote.length > LIMITS.note) fail(`step ${n} note too long`);
      if (s.warning && s.warning.length > LIMITS.note) fail(`step ${n} warning too long`);
    });
  }
}

const detailOf = (s) => {
  const d = {};
  if (s.explanation) d.explanation = s.explanation;
  if (s.checklist && s.checklist.length) d.checklist = s.checklist;
  if (s.importantNote) d.importantNote = s.importantNote;
  if (s.warning) d.warning = s.warning;
  return Object.keys(d).length ? JSON.stringify(d) : null;
};

/** The content of a stored version, in the same shape as the document definition, for comparison. */
function signatureOfVersion(item, version) {
  return JSON.stringify({
    shortDescription: version.shortDescription || null,
    requiredReading: version.requiredReading,
    roles: item.rolesJson || null,
    category: item.category || null,
    important: Boolean(version.important),
    quickReference: Boolean(item.quickReference),
    blocks: JSON.stringify(parseBlocks(version.contentJson)),
    items: (version.responsibilities || []).map((r) => r.text),
    steps: (version.steps || []).map((s) => ({ title: s.title, instruction: s.instruction, detail: s.detailJson || null })),
  });
}
/** The audience stored on the item: a list of roles, or null for Everyone (doc.audience === null). */
const audienceOf = (doc) => (doc.audience === null ? null : (doc.audience || AUDIENCE));
const audienceJson = (doc) => (audienceOf(doc) === null ? null : JSON.stringify(audienceOf(doc)));
const signatureOfDoc = (doc) => JSON.stringify({
  shortDescription: doc.shortDescription,
  requiredReading: doc.requiredReading,
  roles: audienceJson(doc),
  category: doc.category,
  important: Boolean(doc.important),
  quickReference: Boolean(doc.quickReference),
  blocks: JSON.stringify(doc.blocks || []),
  items: doc.items || [],
  steps: (doc.steps || []).map((s) => ({ title: s.title, instruction: s.instruction, detail: detailOf(s) })),
});

/** Where does this document stand in an organization? 'missing', 'same' (identical to the ready-made wording) or 'different' (edited, or an older version). Writes nothing. */
async function inspectDocument(organizationId, doc) {
  const existing = await prisma.standardsItem.findFirst({
    where: { organizationId, contentType: doc.contentType, title: doc.title, archivedAt: null },
    include: { currentVersion: { include: { steps: { orderBy: { displayOrder: 'asc' } }, responsibilities: { orderBy: { displayOrder: 'asc' } } } } },
  });
  if (!existing) return { state: 'missing', itemId: null };
  const same = existing.currentVersion && signatureOfVersion(existing, existing.currentVersion) === signatureOfDoc(doc);
  return { state: same ? 'same' : 'different', itemId: existing.id };
}

async function importDocument(admin, doc, { dry }) {
  validate(doc);
  const existing = await prisma.standardsItem.findFirst({
    where: { organizationId: admin.organizationId, contentType: doc.contentType, title: doc.title, archivedAt: null },
    include: { currentVersion: { include: { steps: { orderBy: { displayOrder: 'asc' } }, responsibilities: { orderBy: { displayOrder: 'asc' } } } } },
  });
  if (existing && existing.currentVersion && signatureOfVersion(existing, existing.currentVersion) === signatureOfDoc(doc)) {
    return { action: 'unchanged', itemId: existing.id, version: existing.currentVersion.version, status: existing.currentVersion.status };
  }
  if (dry) return { action: existing ? 'would-update' : 'would-create' };

  const item = existing || await prisma.standardsItem.create({
    data: { organizationId: admin.organizationId, contentType: doc.contentType, title: doc.title, category: doc.category, rolesJson: audienceJson(doc), quickReference: Boolean(doc.quickReference), createdById: admin.id },
  });
  const last = await prisma.standardsVersion.findFirst({ where: { itemId: item.id }, orderBy: { version: 'desc' } });
  // Updating an existing item keeps its acknowledgement setting (an Admin may have switched it on); new
  // versions never ask people to re-acknowledge by themselves, so no existing acknowledgement is voided.
  const keepsAcknowledgement = Boolean(existing && existing.currentVersion && existing.currentVersion.acknowledgementRequired);
  const versionNumber = last ? last.version + 1 : 1;
  const version = await prisma.standardsVersion.create({
    data: {
      itemId: item.id, version: versionNumber, status: 'DRAFT', createdById: admin.id,
      shortDescription: doc.shortDescription, important: Boolean(doc.important), requiredReading: doc.requiredReading,
      acknowledgementRequired: keepsAcknowledgement, requireReacknowledgement: false, contentJson: blocksToJson(doc.blocks),
    },
  });
  if (doc.contentType === 'RESPONSIBILITY') await prisma.standardsResponsibilityItem.createMany({ data: doc.items.map((text, i) => ({ versionId: version.id, displayOrder: i, text })) });
  if (doc.contentType === 'WORKFLOW') await prisma.standardsStep.createMany({ data: doc.steps.map((s, i) => ({ versionId: version.id, displayOrder: i, title: s.title, instruction: s.instruction, detailJson: detailOf(s) })) });

  const previousId = item.currentVersionId;
  await prisma.$transaction([
    prisma.standardsItem.update({ where: { id: item.id }, data: { title: doc.title, category: doc.category, rolesJson: audienceJson(doc), quickReference: Boolean(doc.quickReference), currentVersionId: version.id } }),
    prisma.standardsVersion.update({ where: { id: version.id }, data: { status: 'PUBLISHED', publishedById: admin.id, publishedAt: new Date() } }),
    ...(previousId && previousId !== version.id ? [prisma.standardsVersion.update({ where: { id: previousId }, data: { status: 'ARCHIVED', archivedAt: new Date() } })] : []),
  ]);
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: existing ? 'standards.version_created' : 'standards.item_created', targetTable: 'StandardsItem', targetId: item.id, metadata: { title: doc.title, contentType: doc.contentType, via: doc.source || 'import-supervisor-standards', roles: doc.audience === null ? 'EVERYONE' : (doc.audience || AUDIENCE) } });
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'standards.published', targetTable: 'StandardsItem', targetId: item.id, metadata: { title: doc.title, versionId: version.id, version: versionNumber, via: doc.source || 'import-supervisor-standards' } });
  return { action: existing ? 'updated' : 'created', itemId: item.id, version: versionNumber, status: 'PUBLISHED' };
}

/** Imports any list of document definitions ({contentType, title, category, audience?, ...}); shared by the role-specific import scripts. */
async function importDocuments(documents, { adminId, email, dry = false } = {}) {
  const admin = adminId
    ? await prisma.profile.findFirst({ where: { id: adminId, role: 'ADMIN' } })
    : await prisma.profile.findFirst({ where: { role: 'ADMIN', status: 'ACTIVE', testOwnerAdminId: null, ...(email ? { email: email.toLowerCase() } : {}) }, orderBy: { createdAt: 'asc' } });
  if (!admin) throw new Error(email ? `No active Admin with email ${email}.` : 'No active Admin found.');
  const results = [];
  for (const doc of documents) results.push({ title: doc.title, type: doc.contentType, ...(await importDocument(admin, doc, { dry })) });
  return { admin: { id: admin.id, name: admin.fullName }, results };
}

const importSupervisorStandards = (options) => importDocuments(DOCUMENTS, options);

/** Command-line runner used by every import script: --dry, --email <admin email>. */
function runCli(documents) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  return importDocuments(documents, { email: arg('--email'), dry: process.argv.includes('--dry') })
    .then(({ admin, results }) => {
      console.log(`Author/publisher recorded as: ${admin.name}`);
      for (const r of results) console.log(`- ${r.type} "${r.title}": ${r.action}${r.version ? ` (version ${r.version}, ${r.status})` : ''}`);
    })
    .catch((err) => { console.error('Import failed:', err.message); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}

module.exports = { importSupervisorStandards, importDocuments, importDocument, inspectDocument, audienceOf, runCli, DOCUMENTS, validate, LIMITS };

if (require.main === module) runCli(DOCUMENTS);
