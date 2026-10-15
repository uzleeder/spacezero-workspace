'use strict';
// AI Practice workflow: SOURCE -> ANALYSIS -> PRACTICE -> REVIEW -> TRAINING, with versioning, recovery,
// idempotency, safe deletion, security and the link to Phase 3 skill evidence. Gemini is mocked.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used';
const calls = { extract: 0, map: 0, validate: 0, practiceCheck: 0, questions: 0, roleplay: 0, process: 0, oneQuestion: 0 };
const sent = []; // every prompt that would have been sent to Gemini
const behave = { failMapOnce: false, failRoleplay: false };
let questionSeq = 0;
mock.method(require('../lib/gemini'), 'generateStructured', async (input) => {
  const props = Object.keys(input.responseSchema.properties || {});
  sent.push(JSON.stringify(input.contents));
  if (props.includes('criticalKnowledge')) {
    calls.extract += 1;
    return { modelVersion: 'test-model', task: input.task, promptVersion: input.promptVersion, data: { criticalKnowledge: ['Reprice after any segment change.', 'Verify the cabin on every segment.'], practicalBehaviors: ['Check baggage before selling.'], commonMistakes: ['Selling before checking baggage.'], procedures: ['1. Reprice. 2. Verify cabin. 3. Ticket.'], sourceMap: [
      { fact: 'Reprice after any segment change', sourceTitle: 'Sabre guide', location: 'page 4' },
      { fact: 'Verify the cabin on every segment', sourceTitle: 'Sabre guide', location: '' },
    ] } };
  }
  if (props.includes('classifications')) {
    calls.map += 1;
    if (behave.failMapOnce) { behave.failMapOnce = false; throw Object.assign(new Error('Model unavailable (test)'), { name: 'GeminiError', retryable: false }); }
    return { modelVersion: 'test-model', data: { classifications: ['TECHNICAL', 'PROCESS_SOP'], objectives: ['Reprice correctly after a change', 'Explain fare rules to a client'], extractedSkills: ['Sabre Availability', 'Fare Rules'], difficulty: 'MEDIUM', recommendedMethods: ['QUIZ', 'ROLEPLAY'], recommendedIntensity: 3, audienceRoles: ['FLIGHT_EXPERT'], estimatedMinutes: 30,
      objectiveSupport: [{ objective: 'Reprice correctly after a change', factNumbers: [1], confidence: 'HIGH' }, { objective: 'Explain fare rules to a client', factNumbers: [], confidence: 'HIGH' }],
      skillSupport: [{ skill: 'Sabre Availability', factNumbers: [1, 2], confidence: 'HIGH' }] } };
  }
  if (props.includes('supportedBySource')) { calls.validate += 1; return { modelVersion: 'test-model', data: { supportedBySource: true, notes: [] } }; }
  if (props.includes('coverageGaps')) { calls.practiceCheck += 1; return { modelVersion: 'test-model', data: { items: [{ ref: 'Q1', supportedBySource: true, testsApplication: true, note: 'ok' }], coverageGaps: [] } }; }
  if (props.includes('questions')) {
    calls.questions += 1; questionSeq += 1;
    return { modelVersion: 'test-model', data: { questions: [
      { type: 'MCQ', prompt: `Set ${questionSeq}: what after a segment change?`, options: ['Reprice', 'Ticket now'], correctAnswer: 'Reprice', explanation: 'Fares change.', skillNames: ['Sabre Availability'], sourceTitle: 'Sabre guide', sourceLocation: 'page 4' },
      { type: 'TRUE_FALSE', prompt: `Set ${questionSeq}: a hold is always free.`, options: ['True', 'False'], correctAnswer: 'False', skillNames: [] },
    ] } };
  }
  if (props.includes('customerPersonality')) {
    calls.roleplay += 1;
    if (behave.failRoleplay) throw Object.assign(new Error('Roleplay generation unavailable (test)'), { name: 'GeminiError', retryable: false });
    return { modelVersion: 'test-model', data: { customerPersonality: 'busy executive', scenarioBrief: `Scenario ${calls.roleplay}: the client wants a discount.`, openingLine: 'Just give me your best price.', rubricSkills: ['Objection Handling', 'Discovery', 'Closing'] } };
  }
  if (props.includes('startId')) { calls.process += 1; throw new Error('process simulation is not expected in these tests'); }
  if (props.includes('prompt') && props.includes('correctAnswer')) {
    calls.oneQuestion += 1;
    return { modelVersion: 'test-model', data: { type: 'MCQ', prompt: 'Rewritten: what do you do after a segment change?', options: ['Reprice', 'Ignore'], correctAnswer: 'Reprice', skillNames: [] } };
  }
  throw new Error(`unexpected Gemini call: ${props.join(',')}`);
});

const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { runPipeline, computeSourceHash } = require('../lib/trainingAnalysis');
const tasks = require('../lib/aiTasks');
const versions = require('../lib/courseVersions');
const state = require('../lib/aiPracticeState');
const { ensureWorkspace } = require('../lib/aiPracticeBackfill');
const { relevanceFor } = require('../lib/practiceRelevance');
const { bulkAssign } = require('../lib/bulkAssign');
const { recordAssessmentAttempt } = require('../lib/practiceAttempts');
const { saveUpload, resolveStoragePath } = require('../lib/storage');
const app = require('../server');

let org, otherOrg, admin, admin2, sup, agent, agent2, expert;
let cookies = {}; let sabreSkill;
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const savedId = (res) => new URL(res.headers.location, 'http://x').searchParams.get('saved');
const blocked = (res) => res.status !== 200 && res.status < 500;
const pdf = () => Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF');
function wav(seconds = 2) {
  const data = Buffer.alloc(44 + 16000 * seconds); data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(16000 * seconds, 40);
  return data;
}
const audits = (action) => prisma.auditLog.findMany({ where: { organizationId: org.id, action } });
const resetCalls = () => { for (const k of Object.keys(calls)) calls[k] = 0; sent.length = 0; };

async function makeUser(role, name, organizationId = org.id) {
  const p = await prisma.profile.create({ data: { organizationId, fullName: `AIP ${name}`, username: `aip_${organizationId}_${name}`, email: `aip_${organizationId}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date(Date.now() - 100 * 86400000) } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookies[p.id] = `sz_session=${token.raw}`;
  return p;
}
/** A saved source made of notes only (so the analysis can run against the mocked AI). */
async function noteSource(title = 'Sabre guide', text = 'Reprice after any segment change. Verify the cabin on every segment.') {
  const res = await request(app).post('/ai-practice/new').set('Cookie', cookies[admin.id]).field('kind', 'material').field('title', title).field('noteText', text);
  assert.equal(res.status, 302, res.text);
  const course = await prisma.trainingCourse.findUnique({ where: { id: savedId(res) }, include: { modules: true } });
  await prisma.trainingModule.updateMany({ where: { courseId: course.id }, data: { title } }); // the source map refers to modules by title
  return course;
}
async function analyzed(title) {
  const course = await noteSource(title);
  assert.equal((await post(admin, `/ai-practice/${course.id}/analyze`, { purpose: 'AUTO' })).status, 302);
  const row = await prisma.trainingAnalysis.findUnique({ where: { courseId: course.id } });
  await runPipeline(row.id);
  return course;
}
/** The learner has finished the required material of a training (the practice only opens after it). */
async function finishMaterial(profile, courseId) {
  const { consumable } = require('../lib/mediaProgress');
  for (const m of await prisma.trainingModule.findMany({ where: { courseId } })) if (consumable(m)) await prisma.mediaProgress.upsert({ where: { profileId_trainingModuleId: { profileId: profile.id, trainingModuleId: m.id } }, create: { profileId: profile.id, trainingModuleId: m.id, completedAt: new Date(), percentComplete: 100 }, update: { completedAt: new Date() } });
}
const reload = (id) => prisma.trainingCourse.findUnique({ where: { id } });

before(async () => {
  org = await prisma.organization.create({ data: { name: 'AIP workflow' } });
  otherOrg = await prisma.organization.create({ data: { name: 'AIP other org' } });
  admin = await makeUser('ADMIN', 'admin'); admin2 = await makeUser('ADMIN', 'admin2', otherOrg.id);
  sup = await makeUser('SUPERVISOR', 'sup'); agent = await makeUser('TRAVEL_AGENT', 'agent'); agent2 = await makeUser('TRAVEL_AGENT', 'agent2'); expert = await makeUser('FLIGHT_EXPERT', 'expert');
  sabreSkill = await prisma.skill.create({ data: { organizationId: org.id, name: 'Sabre Availability', roleKey: 'FLIGHT_EXPERT', category: 'GDS' } });
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup.id, agentId: expert.id, assignedById: admin.id } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

// ================================================================== SOURCE
test('SOURCE: upload only SAVES — no analysis, no AI call, listed as Saved, and it is still there after logging in again', async () => {
  resetCalls();
  const res = await request(app).post('/ai-practice/new').set('Cookie', cookies[admin.id]).field('kind', 'material').field('title', 'Objection Handling Masterclass').attach('files', pdf(), { filename: 'guide.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 302);
  const course = await prisma.trainingCourse.findUnique({ where: { id: savedId(res) }, include: { modules: true, analysis: true } });
  assert.equal(course.origin, 'AI_PRACTICE'); assert.equal(course.status, 'DRAFT'); assert.equal(course.analysis, null);
  assert.equal(course.modules.length, 1); assert.equal(course.modules[0].contentType, 'PDF');
  assert.equal(Object.values(calls).reduce((n, x) => n + x, 0), 0, 'nothing was sent to the AI');
  assert.equal(await prisma.aiTask.count({ where: { courseId: course.id } }), 0);
  // "log out and back in": a brand new session for the same person sees it
  const token = generateToken();
  await prisma.session.create({ data: { profileId: admin.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  const page = await request(app).get('/ai-practice').set('Cookie', `sz_session=${token.raw}`);
  assert.equal(page.status, 200); assert.match(page.text, /Objection Handling Masterclass/); assert.match(page.text, /Saved/); assert.match(page.text, /Start Analysis/);
  assert.equal(state.courseState(course).key, 'SAVED');
  const item = (await state.loadSources(admin)).find((i) => i.id === course.id);
  assert.equal(item.state.key, 'SAVED'); assert.equal(item.uploadedBy, admin.fullName);
});

test('SOURCE: several related files and notes make ONE source; more material can be added later', async () => {
  const res = await request(app).post('/ai-practice/new').set('Cookie', cookies[admin.id]).field('kind', 'material').field('title', 'Sabre ticketing').field('noteText', 'Trainer notes.')
    .attach('files', pdf(), { filename: 'sabre-guide.pdf', contentType: 'application/pdf' }).attach('files', wav(), { filename: 'walkthrough.wav', contentType: 'audio/wav' });
  assert.equal(res.status, 302, res.text);
  const course = await prisma.trainingCourse.findUnique({ where: { id: savedId(res) }, include: { modules: true } });
  assert.deepEqual(course.modules.map((m) => m.contentType).sort(), ['AUDIO', 'NOTE', 'PDF']);
  const audio = course.modules.find((m) => m.contentType === 'AUDIO');
  assert.ok(JSON.parse(audio.sourceRefJson).durationSeconds >= 1, 'media duration is measured on upload');
  const more = await request(app).post(`/ai-practice/${course.id}/sources`).set('Cookie', cookies[admin.id]).field('noteText', 'One more note.');
  assert.equal(more.status, 302);
  assert.equal(await prisma.trainingModule.count({ where: { courseId: course.id } }), 4);
  assert.match((await get(admin, `/ai-practice/${course.id}?step=source`)).text, /Add more material/);
});

test('SOURCE: forged files, unsupported types and oversized batches are refused; nothing half-created; private files need authorization', async () => {
  const before = await prisma.trainingCourse.count({ where: { organizationId: org.id } });
  const up = (buf, name, type) => request(app).post('/ai-practice/new').set('Cookie', cookies[admin.id]).field('kind', 'material').attach('files', buf, { filename: name, contentType: type });
  assert.equal((await up(Buffer.from('this is not a pdf at all'), 'fake.pdf', 'application/pdf')).status, 400);   // forged content
  assert.equal((await up(Buffer.from('MZ\x90\x00'), 'run.exe', 'application/octet-stream')).status, 400);          // unsupported type
  assert.equal((await up(pdf(), 'renamed.mp4', 'video/mp4')).status, 400);                                          // a PDF renamed to video
  assert.equal(await prisma.trainingCourse.count({ where: { organizationId: org.id } }), before);
  for (const who of [sup, agent, expert]) assert.ok(blocked(await request(app).post('/ai-practice/new').set('Cookie', cookies[who.id]).field('kind', 'material').field('noteText', 'x')));
  // private storage: a source file is only served to someone allowed to see that training
  const withFile = await prisma.trainingModule.findFirst({ where: { course: { organizationId: org.id }, contentType: 'PDF' } });
  assert.equal((await get(admin, `/training-file/${withFile.id}`)).status, 200);
  for (const who of [agent, sup, admin2]) assert.ok(blocked(await get(who, `/training-file/${withFile.id}`)), 'a colleague/outsider cannot open the file');
  assert.ok(blocked(await request(app).get(`/training-file/${withFile.id}`)));
});

test('SOURCE: earlier raw uploads are imported as saved sources (no re-upload), and running it again does not duplicate them', async () => {
  const file = { buffer: pdf(), size: pdf().length, mimetype: 'application/pdf', originalname: 'old.pdf' };
  const stored = await saveUpload(file, 'practice');
  const oldPdf = await prisma.practiceMaterial.create({ data: { organizationId: org.id, profileId: admin.id, title: 'Old Sabre PDF', materialType: 'PDF', storagePath: stored.storagePath, mimeType: 'application/pdf' } });
  const oldNote = await prisma.practiceMaterial.create({ data: { organizationId: org.id, profileId: admin.id, title: 'Old note', materialType: 'NOTE', noteContent: 'Always verify the cabin.' } });
  const first = await ensureWorkspace(admin);
  assert.equal(first.imported, 2);
  assert.equal((await ensureWorkspace(admin)).imported, 0);
  const course = await prisma.trainingCourse.findFirst({ where: { organizationId: org.id, title: 'Old Sabre PDF' }, include: { modules: true } });
  assert.equal(course.origin, 'AI_PRACTICE'); assert.equal(course.modules[0].storagePath, oldPdf.storagePath); // same stored file, nothing copied or lost
  assert.equal((await prisma.practiceMaterial.findUnique({ where: { id: oldNote.id } })).migratedCourseId !== null, true);
  assert.equal(state.courseState({ ...course, analysis: null }).key, 'SAVED');
  assert.equal((await post(admin, `/ai-practice/${course.id}/analyze`, { purpose: 'AUTO' })).status, 302); // "Analyze now" works for an older upload
  assert.ok(await prisma.trainingAnalysis.findUnique({ where: { courseId: course.id } }));
  assert.ok(fs.existsSync(resolveStoragePath(oldPdf.storagePath)));
});

test('SOURCE: an analysis that stopped moving is put back in the queue with its finished steps; the list offers Resume', async () => {
  const course = await noteSource('Stalled source');
  const old = new Date(Date.now() - 3600000);
  const row = await prisma.trainingAnalysis.create({ data: { courseId: course.id, status: 'MAPPING', completedStep: 'EXTRACT', criticalKnowledgeJson: '["kept"]' } });
  await prisma.trainingAnalysis.update({ where: { id: row.id }, data: { updatedAt: old } });
  const halted = state.courseState({ ...(await reload(course.id)), analysis: await prisma.trainingAnalysis.findUnique({ where: { id: row.id } }) });
  assert.equal(halted.key, 'ANALYZING'); assert.equal(halted.halted, true); assert.equal(halted.primary.label, 'Continue');
  const res = await ensureWorkspace(admin);
  assert.ok(res.resumed >= 1);
  const after = await prisma.trainingAnalysis.findUnique({ where: { id: row.id } });
  assert.equal(after.status, 'QUEUED'); assert.equal(after.completedStep, 'EXTRACT'); assert.equal(after.criticalKnowledgeJson, '["kept"]');
});

// ================================================================== ANALYSIS
let src; // the source used for the rest of the flow
test('ANALYSIS: the Admin starts it; a double click creates ONE analysis; it stores prompt version and purpose', async () => {
  src = await noteSource('Sabre guide', 'Reprice after any segment change. Verify the cabin on every segment. Contact me at jane.doe@example.com card 4111 1111 1111 1111.');
  resetCalls();
  const [a, b] = await Promise.all([post(admin, `/ai-practice/${src.id}/analyze`, { purpose: 'TECHNICAL' }), post(admin, `/ai-practice/${src.id}/analyze`, { purpose: 'TECHNICAL' })]);
  assert.equal(a.status, 302); assert.equal(b.status, 302);
  assert.equal(await prisma.trainingAnalysis.count({ where: { courseId: src.id } }), 1);
  assert.equal((await audits('ai_practice.analysis_started')).filter((x) => x.targetId === src.id).length, 1, 'the second click did nothing');
  assert.equal(calls.extract, 0, 'starting does not call the AI in the request; a background job does');
  const row = await prisma.trainingAnalysis.findUnique({ where: { courseId: src.id } });
  assert.equal(row.status, 'QUEUED'); assert.equal(row.purpose, 'TECHNICAL'); assert.equal(row.startedById, admin.id);
  const halfway = await get(admin, `/ai-practice/${src.id}?step=analysis`);
  assert.match(halfway.text, /The AI is reading your material/); assert.match(halfway.text, /data-autorefresh/);
});

test('ANALYSIS: it is schema-validated, redacted before the AI sees it, grounded in the source, and honest about confidence', async () => {
  const row = await prisma.trainingAnalysis.findUnique({ where: { courseId: src.id } });
  await runPipeline(row.id);
  const done = await prisma.trainingAnalysis.findUnique({ where: { courseId: src.id } });
  assert.equal(done.status, 'READY_FOR_REVIEW'); assert.equal(done.completedStep, 'VALIDATE');
  assert.match(done.promptVersion, /analysis\.extract@2/); assert.ok(done.sourceHash);
  const sentText = sent.join('\n');
  assert.doesNotMatch(sentText, /jane\.doe@example\.com/); assert.doesNotMatch(sentText, /4111 1111 1111 1111/); assert.match(sentText, /REDACTED/);
  const insights = JSON.parse(done.insightsJson);
  assert.equal(insights.objectives.length, 2); assert.equal(insights.skills.length, 2);
  // the application, not the model, decides how sure to be
  const { groundInsights } = require('../lib/trainingAnalysis');
  const facts = [{ fact: 'a', sourceTitle: 'S', location: '' }, { fact: 'b', sourceTitle: 'S', location: 'p1' }];
  const g = groundInsights({ objectives: ['o1', 'o2', 'o3'], skills: [], objectiveSupport: [{ objective: 'o1', factNumbers: [1], confidence: 'HIGH' }, { objective: 'o2', factNumbers: [2], confidence: 'HIGH' }, { objective: 'o3', factNumbers: [9], confidence: 'HIGH' }], facts });
  assert.deepEqual(g.objectives.map((o) => o.confidence), ['MEDIUM', 'HIGH', 'NEEDS_REVIEW']); // no location -> capped; located -> kept; cites a fact that does not exist -> needs review
});

test('ANALYSIS: page shows objectives, skills, key knowledge, audience, and WHY (source page) — a claim with no evidence is flagged NEEDS REVIEW', async () => {
  const insights = JSON.parse((await prisma.trainingAnalysis.findUnique({ where: { courseId: src.id } })).insightsJson);
  const byText = Object.fromEntries(insights.objectives.map((o) => [o.text, o]));
  assert.equal(byText['Reprice correctly after a change'].evidence[0].location, 'page 4');
  assert.equal(byText['Explain fare rules to a client'].confidence, 'NEEDS_REVIEW');   // the model said HIGH, the app saw no supporting passage
  assert.deepEqual(insights.audienceRoles, ['FLIGHT_EXPERT']); assert.equal(insights.estimatedMinutes, 30);
  const page = await get(admin, `/ai-practice/${src.id}?step=analysis`);
  assert.equal(page.status, 200);
  for (const text of ['Reprice correctly after a change', 'Sabre Availability', 'Verify the cabin on every segment', 'Flight Expert', '30 minutes', 'Why did the AI say this', 'page 4', 'Needs review', 'Create Recommended Practice', 'Common mistakes']) assert.match(page.text, new RegExp(text));
});

test('ANALYSIS: relevance uses Phase 3 skill data (recommendation only — nothing is assigned)', async () => {
  const row = await prisma.employeeSkill.create({ data: { profileId: expert.id, skillId: sabreSkill.id, currentScore: 48, evidenceCount: 3, confidenceLevel: 'MEDIUM' } });
  const relevance = await relevanceFor(admin, { skills: ['Sabre Availability'], audienceRoles: ['FLIGHT_EXPERT'] });
  assert.ok(relevance.lines.some((l) => /AIP sup's team/.test(l) && /Sabre Availability below 70%/.test(l)), relevance.lines.join(' | '));
  assert.ok(relevance.lines.some((l) => /Flight Expert/.test(l)));
  const page = await get(admin, `/ai-practice/${src.id}?step=analysis`);
  assert.match(page.text, /Relevance/); assert.match(page.text, /nothing is assigned automatically/);
  assert.equal(await prisma.trainingAssignment.count({ where: { courseId: src.id } }), 0);
  await prisma.employeeSkill.delete({ where: { id: row.id } });
});

test('ANALYSIS: a failed step keeps what finished; Retry continues without re-uploading and without repeating extraction', async () => {
  const course = await noteSource('Retry me');
  await post(admin, `/ai-practice/${course.id}/analyze`, { purpose: 'AUTO' });
  const row = await prisma.trainingAnalysis.findUnique({ where: { courseId: course.id } });
  resetCalls(); behave.failMapOnce = true;
  await runPipeline(row.id);
  const failed = await prisma.trainingAnalysis.findUnique({ where: { id: row.id } });
  assert.equal(failed.status, 'FAILED'); assert.equal(failed.completedStep, 'EXTRACT');
  assert.equal(calls.extract, 1);
  const page = await get(admin, `/ai-practice/${course.id}?step=analysis`);
  assert.match(page.text, /couldn.t complete the analysis/); assert.match(page.text, /Your original source is safe/); assert.match(page.text, /Retry Analysis/);
  assert.equal(state.courseState({ ...course, analysis: failed }).primary.label, 'Retry');
  assert.equal((await post(admin, `/ai-practice/${course.id}/analysis/retry`)).status, 302);
  assert.equal((await prisma.trainingAnalysis.findUnique({ where: { id: row.id } })).status, 'QUEUED');
  await runPipeline(row.id);
  assert.equal((await prisma.trainingAnalysis.findUnique({ where: { id: row.id } })).status, 'READY_FOR_REVIEW');
  assert.equal(calls.extract, 1, 'extraction was NOT repeated (cost control)');
  assert.equal(await prisma.trainingModule.count({ where: { courseId: course.id } }), 1, 'the source was never touched');
});

test('ANALYSIS: changing the source afterwards marks the analysis as out of date instead of silently re-running the AI', async () => {
  resetCalls();
  assert.equal((await post(admin, `/ai-practice/${src.id}/sources`, { noteText: 'A new rule.' })).status, 302);
  const page = await get(admin, `/ai-practice/${src.id}?step=analysis`);
  assert.match(page.text, /source changed after this analysis/);
  assert.equal(Object.values(calls).reduce((n, x) => n + x, 0), 0, 'opening pages never calls the AI');
  const course = await prisma.trainingCourse.findUnique({ where: { id: src.id }, include: { modules: true, analysis: true } });
  assert.notEqual(course.analysis.sourceHash, computeSourceHash(course.modules));
  // put it back so the rest of the flow uses a consistent source
  await prisma.trainingModule.deleteMany({ where: { courseId: src.id, title: 'Notes' } });
});

// ================================================================== PRACTICE
let comps;
test('PRACTICE: "Create Recommended Practice" confirms the analysis, queues ONE background build, and never publishes', async () => {
  resetCalls();
  const [a, b] = await Promise.all([post(admin, `/ai-practice/${src.id}/practice/build`, { mode: 'recommended' }), post(admin, `/ai-practice/${src.id}/practice/build`, { mode: 'recommended' })]);
  assert.equal(a.status, 302); assert.equal(b.status, 302);
  assert.equal(await prisma.aiTask.count({ where: { courseId: src.id, taskType: 'PRACTICE_BUILD' } }), 1, 'a double click cannot queue two builds');
  assert.equal((await prisma.trainingAnalysis.findUnique({ where: { courseId: src.id } })).status, 'APPROVED');
  assert.equal(calls.questions + calls.roleplay, 0);
  assert.equal(state.courseState({ ...(await reload(src.id)), analysis: { status: 'APPROVED' } }, { build: await tasks.latestBuild(src.id) }).key, 'BUILDING');
  const done = await tasks.runQueuedBuild(src.id);
  assert.equal(done.status, 'DONE'); assert.equal(done.promptVersion, 'practice.generate@4'); assert.ok(done.model);
  comps = await prisma.assessment.findMany({ where: { courseId: src.id, archivedAt: null }, include: { questions: true }, orderBy: { createdAt: 'asc' } });
  // Master generation rules: ONE short practice by default (the best fit for the kind of source), at Level 2.
  assert.deepEqual(comps.map((c) => c.type), ['QUIZ']);
  assert.equal(comps[0].level, 2);
  assert.ok(comps.every((c) => c.status === 'AI_GENERATED' && c.version === 1 && c.promptVersion === 'practice.generate@4'), 'drafts, versioned, never auto-approved');
  const course = await reload(src.id);
  assert.equal(course.status, 'DRAFT'); assert.equal(course.publishedVersion, 0);
  assert.equal(await prisma.trainingAssignment.count({ where: { courseId: src.id } }), 0, 'the AI assigned nothing');
  assert.equal((await audits('practice.generated')).filter((x) => x.targetId === src.id).length, 1);
  const builder = await get(admin, `/ai-practice/${src.id}?step=practice`);
  assert.match(builder.text, /Practice Builder/); assert.match(builder.text, /Applied Quiz/); assert.doesNotMatch(builder.text, /AI Client Role-play —/);
  assert.equal((await state.loadSources(admin)).find((i) => i.id === src.id).state.key, 'READY_FOR_REVIEW');
});

test('PRACTICE: a second practice is added only on request (+ Add practice) - here 2 role-play scenarios', async () => {
  resetCalls();
  assert.equal((await post(admin, `/ai-practice/${src.id}/practice/add`, { type: 'ROLEPLAY', count: '2', level: '3' })).status, 302);
  const added = await tasks.runQueuedBuild(src.id);
  assert.equal(added.status, 'DONE');
  comps = await prisma.assessment.findMany({ where: { courseId: src.id, archivedAt: null }, include: { questions: true }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(comps.map((c) => c.type).sort(), ['QUIZ', 'ROLEPLAY', 'ROLEPLAY']);
  const builder = await get(admin, `/ai-practice/${src.id}?step=practice`);
  assert.match(builder.text, /AI Client Role-play/); assert.match(builder.text, /2 scenarios/);
});

test('PRACTICE: change ONE question, regenerate ONE question, make ONE role-play harder — only that piece is touched', async () => {
  const quiz = comps.find((c) => c.type === 'QUIZ');
  const [q1, q2] = quiz.questions.sort((a, b) => a.displayOrder - b.displayOrder);
  resetCalls();
  const edit = await post(admin, `/admin/assessments/${quiz.id}/questions/${q1.id}`, { prompt: 'After a segment change you must…', options: 'Reprice\nTicket now', correctAnswer: 'Reprice', explanation: 'Fares change.' });
  assert.equal(edit.status, 302);
  assert.equal((await prisma.question.findUnique({ where: { id: q1.id } })).prompt, 'After a segment change you must…');
  assert.equal(Object.values(calls).reduce((n, x) => n + x, 0), 0, 'a manual edit needs no AI');
  const before2 = await prisma.question.findUnique({ where: { id: q2.id } });
  assert.equal((await post(admin, `/admin/assessments/${quiz.id}/questions/${q1.id}/regenerate`, { instruction: 'Add a price objection.' })).status, 302);
  assert.equal(calls.oneQuestion, 1); assert.equal(calls.questions, 0, 'one question -> one AI call, not the whole quiz');
  assert.match((await prisma.question.findUnique({ where: { id: q1.id } })).prompt, /Rewritten/);
  assert.deepEqual(await prisma.question.findUnique({ where: { id: q2.id } }), before2);
  const rp = comps.find((c) => c.type === 'ROLEPLAY');
  resetCalls();
  assert.equal((await post(admin, `/ai-practice/${src.id}/components/${rp.id}/harder`)).status, 302);
  assert.equal(calls.roleplay, 1);
  assert.equal((await prisma.assessment.findUnique({ where: { id: rp.id } })).level, rp.level + 1);
  const other = comps.filter((c) => c.type === 'ROLEPLAY' && c.id !== rp.id)[0];
  assert.equal((await prisma.assessment.findUnique({ where: { id: other.id } })).level, other.level);
  resetCalls();
  assert.equal((await post(admin, `/ai-practice/${src.id}/components/${rp.id}/adjust`, { instruction: 'Make the customer less cooperative.' })).status, 302);
  assert.equal(calls.roleplay, 1);
});

test('PRACTICE: add and remove components; a failed component keeps the rest and Retry builds only what is missing', async () => {
  resetCalls(); behave.failRoleplay = true;
  assert.equal((await post(admin, `/ai-practice/${src.id}/practice/add`, { type: 'ROLEPLAY', count: '1', level: '4' })).status, 302);
  const failedTask = await tasks.runQueuedBuild(src.id);
  assert.equal(failedTask.status, 'FAILED'); assert.match(failedTask.errorMessage, /Role-play/);
  const live = () => prisma.assessment.count({ where: { courseId: src.id, archivedAt: null, status: { not: 'ARCHIVED' } } });
  assert.equal(await live(), 3, 'what existed is untouched');
  assert.equal(state.courseState({ ...(await reload(src.id)), analysis: { status: 'APPROVED' } }, { build: failedTask, components: await prisma.assessment.findMany({ where: { courseId: src.id, archivedAt: null } }) }).key, 'PRACTICE_DRAFT');
  behave.failRoleplay = false; resetCalls();
  assert.equal((await post(admin, `/ai-practice/${src.id}/practice/retry`)).status, 302);
  const ok = await tasks.runQueuedBuild(src.id);
  assert.equal(ok.status, 'DONE'); assert.equal(calls.roleplay, 1, 'only the missing role-play was built'); assert.equal(calls.questions, 0);
  assert.equal(await live(), 4);
  const extra = await prisma.assessment.findFirst({ where: { courseId: src.id, title: { contains: '(added)' } } });
  assert.equal((await post(admin, `/ai-practice/${src.id}/components/${extra.id}/delete`)).status, 302);
  assert.equal(await live(), 3);
  assert.equal((await prisma.assessment.findUnique({ where: { id: extra.id } })).status, 'ARCHIVED'); // archived, never destroyed
  assert.equal((await post(admin, `/ai-practice/${src.id}/components/${extra.id}/delete`)).status, 404);
});

test('REVIEW: preview as learner records nothing and shows no answers; practice stays a draft until approved; only approved practice can be sent', async () => {
  const snapshot = async () => [await prisma.trainingAttempt.count(), await prisma.skillEvidence.count(), await prisma.notification.count()];
  const before = await snapshot();
  const preview = await get(admin, `/ai-practice/${src.id}/preview`);
  assert.equal(preview.status, 200); assert.match(preview.text, /Nothing you do here is recorded/); assert.doesNotMatch(preview.text, /Correct answer/i);
  for (const c of await prisma.assessment.findMany({ where: { courseId: src.id, archivedAt: null } })) assert.equal((await get(admin, `/admin/assessments/${c.id}/preview`)).status, 200);
  assert.deepEqual(await snapshot(), before, 'previewing writes no attempt, evidence or notification');
  assert.ok((await prisma.assessment.findMany({ where: { courseId: src.id, archivedAt: null } })).every((a) => a.status === 'AI_GENERATED'));
  // sending before approval is refused and changes nothing
  const early = await post(admin, `/ai-practice/${src.id}/send`, { title: 'X', passingScore: '70' });
  assert.match(early.headers.location, /error=/);
  const untouched = await reload(src.id);
  assert.equal(untouched.status, 'DRAFT'); assert.equal(untouched.publishedVersion, 0);
  assert.equal((await get(admin, `/ai-practice/${src.id}/send`)).status, 200);
  // approve
  assert.equal((await post(admin, `/ai-practice/${src.id}/approve`)).status, 302);
  assert.ok((await prisma.assessment.findMany({ where: { courseId: src.id, archivedAt: null } })).every((a) => a.status === 'APPROVED' && a.approvedById === admin.id));
  assert.equal((await state.loadSources(admin)).find((i) => i.id === src.id).state.key, 'APPROVED');
  assert.equal((await audits('practice.package_approved')).length >= 1, true);
  assert.equal((await post(admin, `/ai-practice/${src.id}/approve/revoke`)).status, 302);
  assert.ok((await prisma.assessment.findMany({ where: { courseId: src.id, archivedAt: null } })).every((a) => a.status === 'AI_GENERATED'));
  await post(admin, `/ai-practice/${src.id}/approve`);
});

// ================================================================== TRAINING
test('TRAINING: Send to Training sends the approved package; a double click creates ONE version and NO duplicate training', async () => {
  const skillsBefore = await prisma.employeeSkill.findMany({ select: { id: true, currentScore: true } });
  const body = { title: 'Sabre repricing', description: 'How to reprice.', passingScore: '75', mandatory: '1', durationMinutes: '30', roleKey: 'FLIGHT_EXPERT' };
  const [a, b] = await Promise.all([post(admin, `/ai-practice/${src.id}/send`, body), post(admin, `/ai-practice/${src.id}/send`, body)]);
  assert.equal(a.status, 302); assert.equal(b.status, 302);
  const course = await reload(src.id);
  assert.equal(course.status, 'PUBLISHED'); assert.equal(course.publishedVersion, 1); assert.equal(course.title, 'Sabre repricing'); assert.equal(course.passingScore, 75); assert.equal(course.roleKey, 'FLIGHT_EXPERT'); assert.equal(course.sentById, admin.id);
  assert.equal(await prisma.trainingCourse.count({ where: { organizationId: org.id, title: 'Sabre repricing' } }), 1, 'no duplicate Training entry');
  const rows = await prisma.trainingVersion.findMany({ where: { courseId: src.id } });
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'PUBLISHED');
  const snap = JSON.parse(rows[0].snapshotJson);
  assert.equal(snap.assessmentIds.length, 3); assert.deepEqual(snap.skills, ['Sabre Availability', 'Fare Rules']); assert.ok(snap.analysisApprovedAt);
  assert.equal((await audits('training.sent_to_training')).filter((x) => x.targetId === src.id).length, 1);
  assert.match((await get(admin, '/admin/training')).text, /Sabre repricing/);
  // nothing the AI produced changed anybody's authoritative skill score
  assert.deepEqual(await prisma.employeeSkill.findMany({ select: { id: true, currentScore: true } }), skillsBefore);
  assert.equal(await prisma.trainingAssignment.count({ where: { courseId: src.id } }), 0, 'sending does not assign');
});

test('TRAINING: the package is traceable both ways and the source shows as sent', async () => {
  const training = await get(admin, `/admin/training/${src.id}`);
  assert.equal(training.status, 200);
  assert.match(training.text, /Created through AI Practice/); assert.match(training.text, /View source practice/); assert.match(training.text, /v1/);
  assert.doesNotMatch(training.text, /Analyze with AI/);
  const workspace = await get(admin, `/ai-practice/${src.id}?step=training`);
  assert.match(workspace.text, /Sent to Training/); assert.match(workspace.text, /View in Training/); assert.match(workspace.text, /Version history/);
  assert.equal((await state.loadSources(admin)).find((i) => i.id === src.id).state.key, 'SENT');
  assert.match((await get(admin, '/admin/training')).text, /AI Practice · v1/);
});

let v1Assessment, v1Recipient, v1Attempt;
test('TRAINING: the existing assignment workflow still works and assignments remember the version they got', async () => {
  const result = await bulkAssign(admin, [agent.id, expert.id], { kind: 'COURSE', employeeIds: [agent.id, expert.id], courseId: src.id });
  assert.equal(result.created, 2);
  const assignment = await prisma.trainingAssignment.findFirst({ where: { courseId: src.id } });
  assert.equal(assignment.courseVersion, 1);
  v1Recipient = await prisma.trainingAssignmentRecipient.findFirst({ where: { profileId: agent.id, assignmentId: assignment.id } });
  v1Assessment = await prisma.assessment.findFirst({ where: { courseId: src.id, type: 'QUIZ', archivedAt: null }, include: { questions: true } });
  await finishMaterial(agent, src.id);
  assert.equal((await get(agent, `/assessments/${v1Assessment.id}/take`)).status, 200);
  // the classic /assignments page also lists this training
  assert.equal((await get(admin, `/assignments?courseId=${src.id}`)).status, 200);
  // a completed attempt writes SkillEvidence through the deterministic engine (not the AI)
  v1Attempt = await recordAssessmentAttempt({ actor: agent, assessment: v1Assessment, recipientId: v1Recipient.id, score: 82, passed: true, skillBreakdown: { 'Sabre Availability': 82 } });
  const evidence = await prisma.skillEvidence.findFirst({ where: { sourceId: v1Attempt.id } });
  assert.equal(evidence.assessmentId, v1Assessment.id); assert.equal(evidence.scoreImpact, 82);
});

test('VERSIONING: a sent version cannot be edited in place; version 2 is an editable copy; assigned learners keep version 1', async () => {
  // in-place edits of version 1 are refused, on every route
  const q = v1Assessment.questions[0];
  const edit = await post(admin, `/admin/assessments/${v1Assessment.id}/questions/${q.id}`, { prompt: 'Sneaky change', options: 'A\nB', correctAnswer: 'A' });
  assert.equal(edit.status, 409); assert.match(edit.text, /Create a new version/);
  assert.equal((await post(admin, `/admin/assessments/${v1Assessment.id}/revise`, { instruction: 'make it easier' })).status, 409);
  assert.equal((await post(admin, `/admin/assessments/${v1Assessment.id}/delete`)).status, 409);
  assert.equal((await post(admin, `/ai-practice/${src.id}/practice/build`, { mode: 'recommended' })).headers.location.includes('error'), true);
  assert.equal((await prisma.question.findUnique({ where: { id: q.id } })).prompt, q.prompt);
  // new version
  const [a, b] = await Promise.all([post(admin, `/ai-practice/${src.id}/new-version`), post(admin, `/ai-practice/${src.id}/new-version`)]);
  assert.equal(a.status, 302); assert.equal(b.status, 302);
  const course = await reload(src.id);
  assert.equal(course.draftVersion, 2); assert.equal(course.publishedVersion, 1);
  const v2 = await prisma.assessment.findMany({ where: { courseId: src.id, version: 2 }, include: { questions: true } });
  assert.equal(v2.length, 3, 'a copy of the three components, created once'); assert.ok(v2.every((a2) => a2.status === 'AI_GENERATED' && a2.sourceAssessmentId));
  const v2Quiz = v2.find((a2) => a2.type === 'QUIZ');
  assert.equal((await post(admin, `/admin/assessments/${v2Quiz.id}/questions/${v2Quiz.questions[0].id}`, { prompt: 'Improved wording', options: 'Reprice\nTicket now', correctAnswer: 'Reprice' })).status, 302);
  assert.equal((await prisma.question.findUnique({ where: { id: q.id } })).prompt, q.prompt, 'version 1 is exactly as it was');
  // the state and Training reflect both
  const stateNow = (await state.loadSources(admin)).find((i) => i.id === src.id).state;
  assert.equal(stateNow.key, 'READY_FOR_REVIEW'); assert.match(stateNow.note, /version 1 stays in Training/);
  assert.equal((await get(admin, '/admin/training')).status, 200);
  // learner assigned v1: still gets v1, cannot reach v2 practice
  assert.equal((await get(agent, `/assessments/${v1Assessment.id}/take`)).status, 200);
  await prisma.assessment.update({ where: { id: v2Quiz.id }, data: { status: 'APPROVED' } }); // even if it were approved, it is not assigned to them
  assert.equal((await get(agent, `/assessments/${v2Quiz.id}/take`)).status, 404);
  await prisma.assessment.update({ where: { id: v2Quiz.id }, data: { status: 'AI_GENERATED' } });
  // publishing v2 requires approval first
  assert.match((await post(admin, `/ai-practice/${src.id}/send`, { title: 'Sabre repricing', passingScore: '75' })).headers.location, /error=/);
  assert.equal((await reload(src.id)).publishedVersion, 1);
});

test('VERSIONING: publishing version 2 supersedes v1 for NEW assignments only; old results stay tied to v1; nothing changed for completed training', async () => {
  assert.equal((await post(admin, `/ai-practice/${src.id}/approve`)).status, 302);
  const sendV2 = await post(admin, `/ai-practice/${src.id}/send`, { title: 'Sabre repricing', passingScore: '75', mandatory: '1', roleKey: 'FLIGHT_EXPERT' });
  assert.match(sendV2.headers.location, /Sent%20to%20Training%20as%20version%202/);
  const course = await reload(src.id);
  assert.equal(course.publishedVersion, 2);
  const rows = await prisma.trainingVersion.findMany({ where: { courseId: src.id }, orderBy: { version: 'asc' } });
  assert.deepEqual(rows.map((r) => [r.version, r.status]), [[1, 'SUPERSEDED'], [2, 'PUBLISHED']]);
  assert.equal(await prisma.trainingCourse.count({ where: { organizationId: org.id, title: 'Sabre repricing' } }), 1);
  // the old learner keeps their version and their completed result
  const oldAttempt = await prisma.trainingAttempt.findUnique({ where: { id: v1Attempt.id } });
  assert.equal(oldAttempt.assessmentId, v1Assessment.id); assert.equal(oldAttempt.score, 82); assert.equal(oldAttempt.status, 'COMPLETED');
  assert.equal((await prisma.assessment.findUnique({ where: { id: v1Assessment.id } })).status, 'APPROVED');
  assert.equal((await get(agent, `/assessments/${v1Assessment.id}/take`)).status, 200);
  // a NEW assignment gets version 2 and only version 2's practice
  const created = await bulkAssign(admin, [agent2.id], { kind: 'COURSE', employeeIds: [agent2.id], courseId: src.id });
  await finishMaterial(agent2, src.id);
  assert.equal(created.created, 1);
  const fresh = await prisma.trainingAssignment.findFirst({ where: { courseId: src.id, recipients: { some: { profileId: agent2.id } } } });
  assert.equal(fresh.courseVersion, 2);
  const v2Quiz = await prisma.assessment.findFirst({ where: { courseId: src.id, version: 2, type: 'QUIZ', archivedAt: null } });
  assert.equal((await get(agent2, `/assessments/${v2Quiz.id}/take`)).status, 200);
  assert.equal((await get(agent2, `/assessments/${v1Assessment.id}/take`)).status, 404);
  // the assign form offers only the current version's practice
  const dev = await require('../lib/development').nextActions(await prisma.profile.findUnique({ where: { id: agent.id } }));
  assert.ok(dev.learning.every((l) => l.assignment.courseVersion === 1));
});

test('DELETION: unused sources can be deleted; anything that training or evidence depends on is archived instead', async () => {
  const unused = await noteSource('Never used');
  assert.equal((await versions.deletionPolicy(unused)).canDelete, true);
  assert.equal((await post(admin, `/ai-practice/${unused.id}/delete`)).headers.location, '/ai-practice?notice=deleted');
  assert.equal(await prisma.trainingCourse.count({ where: { id: unused.id } }), 0);
  const policy = await versions.deletionPolicy(await reload(src.id));
  assert.equal(policy.canDelete, false); assert.ok(policy.reasons.length >= 2);
  const res = await post(admin, `/ai-practice/${src.id}/delete`);
  assert.match(decodeURIComponent(res.headers.location), /Archived instead of deleted/);
  const kept = await reload(src.id);
  assert.ok(kept.workspaceArchivedAt); assert.equal(kept.status, 'PUBLISHED'); // Training and every learner record are intact
  assert.equal(await prisma.trainingAttempt.count({ where: { id: v1Attempt.id } }), 1);
  assert.equal((await post(admin, `/admin/training/${src.id}/delete`)).status, 409); // the Training screen refuses too
  assert.equal(await prisma.trainingCourse.count({ where: { id: src.id } }), 1);
  assert.ok(!(await state.loadSources(admin)).some((i) => i.id === src.id));
  assert.ok((await state.loadSources(admin, { archived: true })).some((i) => i.id === src.id));
  assert.equal((await post(admin, `/ai-practice/${src.id}/restore`)).status, 302);
  assert.equal((await reload(src.id)).workspaceArchivedAt, null);
  // bulk: unused deleted, protected skipped
  const another = await noteSource('Bulk unused');
  const bulk = await post(admin, '/ai-practice/bulk', { action: 'delete', ids: [`material:${another.id}`, `material:${src.id}`] });
  assert.equal(await prisma.trainingCourse.count({ where: { id: another.id } }), 0);
  assert.equal(await prisma.trainingCourse.count({ where: { id: src.id } }), 1);
  assert.match(decodeURIComponent(bulk.headers.location), /1 deleted; 1 skipped/);
});

// ================================================================== CALLS
test('CALLS: recordings are saved privately and not analyzed until the Admin chooses a purpose and confirms authorization', async () => {
  resetCalls();
  const res = await request(app).post('/ai-practice/new').set('Cookie', cookies[admin.id]).field('kind', 'call').field('title', 'Best sales call').attach('files', wav(3), { filename: 'call.wav', contentType: 'audio/wav' });
  assert.equal(res.status, 302, res.text);
  const batch = await prisma.callBatch.findUnique({ where: { id: savedId(res) }, include: { recordings: true } });
  assert.equal(batch.status, 'UPLOADED'); assert.equal(batch.analysisRequestedAt, null); assert.equal(batch.title, 'Best sales call');
  assert.equal(batch.recordings[0].durationSeconds, 3);
  assert.equal(state.callState(batch).key, 'SAVED');
  assert.ok(!batch.recordings[0].storagePath.startsWith('/'));
  assert.equal(Object.values(calls).reduce((n, x) => n + x, 0), 0);
  for (const who of [sup, agent, expert, admin2]) assert.ok(blocked(await get(who, `/ai-practice/calls/${batch.id}`)), 'recordings are Admin-only and organization-scoped');
  const noConsent = await post(admin, `/ai-practice/calls/${batch.id}/analyze`, { purpose: 'BEST_PRACTICE' });
  assert.match(noConsent.headers.location, /error=/);
  const individualWithoutPerson = await post(admin, `/ai-practice/calls/${batch.id}/analyze`, { purpose: 'INDIVIDUAL', authorized: 'yes' });
  assert.match(individualWithoutPerson.headers.location, /error=/);
  assert.equal((await prisma.callBatch.findUnique({ where: { id: batch.id } })).analysisRequestedAt, null);
  const [a, b] = await Promise.all([post(admin, `/ai-practice/calls/${batch.id}/analyze`, { purpose: 'AUTO', authorized: 'yes' }), post(admin, `/ai-practice/calls/${batch.id}/analyze`, { purpose: 'AUTO', authorized: 'yes' })]);
  assert.equal(a.status, 302); assert.equal(b.status, 302);
  const started = await prisma.callBatch.findUnique({ where: { id: batch.id } });
  assert.ok(started.analysisRequestedAt); assert.equal(started.mode, 'BEST_PRACTICE'); assert.equal(started.purpose, 'AUTO');
  assert.equal((await audits('ai_practice.analysis_started')).filter((x) => x.targetId === batch.id).length, 1);
  assert.equal(state.callState(started).key, 'ANALYZING');
  // deleting saved-but-unanalyzed recordings is allowed; deleting while analyzing is not
  assert.equal((await post(admin, `/ai-practice/calls/${batch.id}/delete`)).status, 409);
});

// ================================================================== SECURITY
test('SECURITY: every AI Practice route is Admin-only and organization-scoped; object IDs from elsewhere look like they do not exist', async () => {
  const course = await noteSource('Security probe');
  const [comp] = await Promise.all([prisma.assessment.create({ data: { organizationId: org.id, courseId: course.id, createdById: admin.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', title: 'Probe', status: 'AI_GENERATED' } })]);
  const gets = ['/ai-practice', '/ai-practice/new', `/ai-practice/${course.id}`, `/ai-practice/${course.id}?step=analysis`, `/ai-practice/${course.id}/analyze`, `/ai-practice/${course.id}/preview`, `/ai-practice/${course.id}/send`];
  const posts = [`/ai-practice/${course.id}/analyze`, `/ai-practice/${course.id}/analysis/retry`, `/ai-practice/${course.id}/analysis/approve`, `/ai-practice/${course.id}/practice/build`, `/ai-practice/${course.id}/practice/add`, `/ai-practice/${course.id}/components/${comp.id}/delete`, `/ai-practice/${course.id}/components/${comp.id}/regenerate`, `/ai-practice/${course.id}/approve`, `/ai-practice/${course.id}/send`, `/ai-practice/${course.id}/new-version`, `/ai-practice/${course.id}/archive`, `/ai-practice/${course.id}/delete`, `/ai-practice/${course.id}/duplicate`, `/ai-practice/${course.id}/rename`, `/ai-practice/${course.id}/sources`, '/ai-practice/bulk'];
  for (const who of [sup, agent, expert]) {
    for (const u of gets) assert.ok(blocked(await get(who, u)), `${who.role} GET ${u}`);
    for (const u of posts) assert.ok(blocked(await post(who, u, { action: 'delete', ids: [`material:${course.id}`] })), `${who.role} POST ${u}`);
  }
  for (const u of gets.slice(2)) assert.equal((await get(admin2, u)).status, 404, `other organization GET ${u}`);
  for (const u of posts.slice(0, -1)) assert.equal((await post(admin2, u)).status, 404, `other organization POST ${u}`);
  await post(admin2, '/ai-practice/bulk', { action: 'delete', ids: [`material:${course.id}`] });
  assert.equal(await prisma.trainingCourse.count({ where: { id: course.id } }), 1, 'an outsider cannot delete or archive through bulk');
  assert.equal((await prisma.trainingCourse.findUnique({ where: { id: course.id } })).workspaceArchivedAt, null);
  // a component that belongs to a different course cannot be driven through this one
  const other = await noteSource('Other source');
  assert.equal((await post(admin, `/ai-practice/${other.id}/components/${comp.id}/delete`)).status, 404);
  assert.equal((await prisma.assessment.findUnique({ where: { id: comp.id } })).status, 'AI_GENERATED');
  // non-cuid ids never reach the handlers
  assert.equal((await get(admin, '/ai-practice/not-an-id')).status, 404);
});

test('SECURITY: Gemini has no authority — after the whole flow nobody was assigned, no permission or setting changed, no score written by AI', async () => {
  const orgSettings = await prisma.orgSetting.count({ where: { organizationId: org.id } });
  const before = await prisma.employeeSkill.findMany({ select: { id: true, currentScore: true, evidenceCount: true } });
  const roles = await prisma.profile.findMany({ where: { organizationId: org.id }, select: { id: true, role: true, status: true } });
  const course = await analyzed('Authority probe');
  await post(admin, `/ai-practice/${course.id}/practice/build`, { mode: 'recommended' });
  await tasks.runQueuedBuild(course.id);
  assert.equal((await reload(course.id)).status, 'DRAFT', 'the AI cannot publish');
  assert.equal(await prisma.trainingAssignment.count({ where: { courseId: course.id } }), 0, 'the AI cannot assign');
  assert.deepEqual(await prisma.profile.findMany({ where: { organizationId: org.id }, select: { id: true, role: true, status: true } }), roles);
  assert.equal(await prisma.orgSetting.count({ where: { organizationId: org.id } }), orgSettings);
  assert.deepEqual(await prisma.employeeSkill.findMany({ select: { id: true, currentScore: true, evidenceCount: true } }), before);
});

test('OBSERVABILITY: every AI task records what ran, on which source, with which model and prompt version', async () => {
  const task = await prisma.aiTask.findFirst({ where: { courseId: src.id, taskType: 'PRACTICE_BUILD' }, orderBy: { createdAt: 'asc' } });
  assert.equal(task.organizationId, org.id); assert.equal(task.requestedById, admin.id); assert.equal(task.model, 'test-model'); assert.equal(task.promptVersion, 'practice.generate@4');
  assert.ok(task.startedAt && task.finishedAt); assert.equal(task.activeKey, null, 'a finished task no longer blocks a new one');
  assert.match(task.resultJson, /"built"/);
  const failed = await prisma.aiTask.findFirst({ where: { courseId: src.id, status: 'FAILED' } });
  assert.ok(failed.errorMessage); assert.doesNotMatch(failed.errorMessage, /GEMINI_API_KEY|sk-|AIza/);
  const analysis = await prisma.trainingAnalysis.findUnique({ where: { courseId: src.id } });
  assert.ok(analysis.modelVersion && analysis.promptVersion && analysis.sourceHash);
});

// ================================================================== reference knowledge, scenario and call coaching
test('ANALYSIS: approved Library items can be used as background reference — only own, non-archived, explicitly chosen ones; never cited as a source', async () => {
  const mine = await prisma.libraryItem.create({ data: { organizationId: org.id, createdById: admin.id, itemType: 'NOTE', title: 'House rule', description: 'Above9 house rule: always quote fares in USD. Contact ops@above9.example.' } });
  const archived = await prisma.libraryItem.create({ data: { organizationId: org.id, createdById: admin.id, itemType: 'NOTE', title: 'Old archived rule', description: 'archived text', archivedAt: new Date() } });
  const foreign = await prisma.libraryItem.create({ data: { organizationId: otherOrg.id, createdById: admin2.id, itemType: 'NOTE', title: 'Foreign secret', description: 'foreign text' } });
  const unchosen = await prisma.libraryItem.create({ data: { organizationId: org.id, createdById: admin.id, itemType: 'NOTE', title: 'Unchosen item', description: 'not selected text' } });
  const course = await noteSource('Reference probe');
  assert.match((await get(admin, `/ai-practice/${course.id}/analyze`)).text, /background reference/);
  await post(admin, `/ai-practice/${course.id}/analyze`, { purpose: 'AUTO', referenceIds: [mine.id, archived.id, foreign.id] });
  const row = await prisma.trainingAnalysis.findUnique({ where: { courseId: course.id } });
  assert.deepEqual(JSON.parse(row.insightsJson).referenceItemIds, [mine.id]);
  resetCalls();
  await runPipeline(row.id);
  const text = sent.join('\n');
  assert.match(text, /always quote fares in USD/); assert.match(text, /background only; do NOT cite/);
  assert.doesNotMatch(text, /ops@above9\.example/);          // redacted like everything else
  for (const leaked of ['archived text', 'foreign text', 'not selected text']) assert.doesNotMatch(text, new RegExp(leaked));
  const facts = JSON.parse((await prisma.trainingAnalysis.findUnique({ where: { id: row.id } })).sourceReferencesJson).facts;
  assert.ok(facts.every((f) => f.sourceTitle === 'Reference probe'), 'only the uploaded source can be cited');
  void unchosen;
});

test('PRACTICE: "Difficult scenario" and "Call coaching" are available and map onto the hardest role-play and voice practice', async () => {
  const course = await analyzed('Scenario probe');
  await post(admin, `/ai-practice/${course.id}/analysis/approve`);
  assert.equal((await post(admin, `/ai-practice/${course.id}/practice/add`, { type: 'SCENARIO', count: '1', level: '2' })).status, 302);
  await tasks.runQueuedBuild(course.id);
  assert.equal((await post(admin, `/ai-practice/${course.id}/practice/add`, { type: 'CALL_COACHING', count: '1', level: '3' })).status, 302);
  await tasks.runQueuedBuild(course.id);
  const made = await prisma.assessment.findMany({ where: { courseId: course.id, archivedAt: null }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(made.map((a) => [a.type, a.level]), [['ROLEPLAY', 5], ['VOICE', 3]]);
  assert.match((await get(admin, `/ai-practice/${course.id}?step=practice`)).text, /Difficult scenario/);
});
