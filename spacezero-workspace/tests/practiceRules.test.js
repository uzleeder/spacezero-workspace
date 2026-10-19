'use strict';
// The AI Practice MASTER GENERATION RULES: the kind of source decides ONE best practice (default size, Level 2),
// every generator gets the rules, role-play keeps the technique and hidden customer facts away from the learner,
// and a speaking practice ends with a debrief.
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const gemini = require('../lib/gemini');
const seen = { structured: [], text: [] };
mock.method(gemini, 'generateText', async (input) => { seen.text.push(input); return { text: 'Customer: I have a budget in mind.' }; });
mock.method(gemini, 'generateStructured', async (input) => {
  seen.structured.push(input);
  const props = Object.keys((input.responseSchema && input.responseSchema.properties) || {});
  if (props.includes('hiddenContext')) return { modelVersion: 'test', data: { customerPersonality: 'price-sensitive traveler', scenarioBrief: 'A client calls about business class to Tokyo.', openingLine: 'Hi, how much is business class to Tokyo?', rubricSkills: ['Discovery', 'Objection handling', 'Closing'], hiddenContext: 'Budget is 2,500 USD and the real objection is the 24 hour layover.', expectedTechnique: 'Ask about budget and flexibility before quoting.' } };
  if (props.includes('questions')) return { modelVersion: 'test', data: { questions: Array.from({ length: 4 }, (_, i) => ({ type: 'MCQ', prompt: `Q${i}`, options: ['Right', 'B', 'C', 'D'], correctAnswer: 'Right' })) } };
  if (props.includes('overallScore')) return { modelVersion: 'test', data: { overallScore: 88, skillScores: [{ skill: 'Discovery', score: 90 }], feedback: 'Good call overall.', didWell: ['Asked about dates'], missed: ['Never asked the budget'], approachUsed: 'Product-first selling', wouldHaveWorkedBetter: 'Asking about budget and flexibility first.', nextStep: 'Ask the budget in your first three questions.' } };
  return { modelVersion: 'test', data: {} };
});
const { sourceKindOf, planFor, rulesFor, primaryPractice, KINDS } = require('../lib/practiceRules');
const { recommendedPlan } = require('../lib/practicePlan');
const { generateQuestionAssessment, generateRoleplayAssessment } = require('../lib/practiceEngine');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const app = require('../server');

const analysis = (classifications, methods, extra = {}) => ({ classificationsJson: JSON.stringify(classifications), recommendedMethodsJson: JSON.stringify(methods), ...extra });
const types = (plan) => plan.map((p) => p.type);

test('the source kind comes from the analysis, and a stored call kind wins', () => {
  assert.equal(sourceKindOf(analysis(['PRODUCT_KNOWLEDGE'], [])), 'PRODUCT_KNOWLEDGE');
  assert.equal(sourceKindOf(analysis(['CUSTOMER_SERVICE'], [])), 'SALES_COMMUNICATION');
  assert.equal(sourceKindOf(analysis(['PROCESS_SOP'], [])), 'CRM_WORKFLOW');
  assert.equal(sourceKindOf(analysis(['TECHNICAL'], [])), 'TECHNICAL');
  assert.equal(sourceKindOf(analysis(['COMPLIANCE_POLICY'], [])), 'COMPANY_STANDARD');
  assert.equal(sourceKindOf(analysis(['LEADERSHIP_SUPERVISOR'], [])), 'COMPANY_STANDARD');
  assert.equal(sourceKindOf(analysis(['MIXED'], [])), null);
  assert.equal(sourceKindOf(null), null);
  assert.equal(sourceKindOf(null, { callMode: 'INDIVIDUAL_AGENT' }), 'CALL_INDIVIDUAL');
  assert.equal(sourceKindOf(null, { callMode: 'BEST_PRACTICE', callOutcome: 'UNSUCCESSFUL' }), 'CALL_IMPROVEMENT');
  assert.equal(sourceKindOf(null, { callMode: 'BEST_PRACTICE', callOutcome: 'SUCCESSFUL' }), 'CALL_SUCCESSFUL');
  assert.equal(sourceKindOf(analysis(['TECHNICAL'], [], { insightsJson: JSON.stringify({ sourceKind: 'CALL_IMPROVEMENT' }) })), 'CALL_IMPROVEMENT');
  assert.equal(Object.keys(KINDS).length, 8);
});

test('each kind gets ONE practice of the right type, sized for 10-15 minutes, at Level 2', () => {
  assert.deepEqual(planFor(analysis(['PRODUCT_KNOWLEDGE'], ['PRODUCT_KNOWLEDGE', 'QUIZ'])), [{ type: 'PRODUCT_KNOWLEDGE', count: 10, level: 2 }]);
  assert.deepEqual(planFor(analysis(['SALES_COMMUNICATION'], ['ROLEPLAY', 'QUIZ', 'VOICE'])), [{ type: 'ROLEPLAY', count: 1, level: 2 }]);
  assert.deepEqual(types(planFor(analysis(['SALES_COMMUNICATION'], ['QUIZ']))), ['QUIZ']);                       // only recognising rules: an applied quiz
  assert.deepEqual(types(planFor(analysis(['PROCESS_SOP'], ['QUIZ', 'PROCESS_SIM']))), ['QUIZ']);                // choose the right action / status
  assert.deepEqual(types(planFor(analysis(['PROCESS_SOP'], ['PROCESS_SIM']))), ['PROCESS_SIM']);                 // an ordered sequence of steps
  assert.deepEqual(types(planFor(analysis(['TECHNICAL'], ['TECHNICAL', 'QUIZ']))), ['TECHNICAL']);
  assert.deepEqual(types(planFor(analysis(['TECHNICAL'], ['PROCESS_SIM', 'QUIZ']))), ['PROCESS_SIM']);
  assert.deepEqual(types(planFor(analysis(['COMPLIANCE_POLICY'], ['QUIZ', 'ROLEPLAY']))), ['QUIZ']);
  assert.deepEqual(types(planFor(analysis([], ['QUIZ', 'ROLEPLAY']))), ['QUIZ']);                                // unknown kind: the best-fit recommendation
  assert.deepEqual(types(planFor(analysis([], []))), ['QUIZ']);
  for (const p of [...planFor(analysis(['TECHNICAL'], ['TECHNICAL'])), ...planFor(analysis(['SALES_COMMUNICATION'], ['ROLEPLAY']))]) assert.equal(p.level, 2);
  assert.equal(primaryPractice('PRODUCT_KNOWLEDGE', ['QUIZ']), 'QUIZ'); // never a practice the analysis ruled out
});

test('calls become ONE conversational practice by default; a second practice only when the source clearly teaches two skills', () => {
  for (const callMode of ['INDIVIDUAL_AGENT', 'BEST_PRACTICE']) assert.deepEqual(types(planFor(analysis([], ['QUIZ', 'ROLEPLAY']), { callMode })), ['ROLEPLAY']);
  assert.deepEqual(types(planFor(analysis([], ['QUIZ']), { callMode: 'BEST_PRACTICE' })), ['QUIZ']); // decision recognition only
  // two different kinds AND the analysis recommended both practices -> two
  assert.deepEqual(types(planFor(analysis(['PRODUCT_KNOWLEDGE', 'SALES_COMMUNICATION'], ['PRODUCT_KNOWLEDGE', 'ROLEPLAY']))), ['PRODUCT_KNOWLEDGE', 'ROLEPLAY']);
  // the same kind twice, or a second kind whose practice was not recommended -> still one
  assert.deepEqual(types(planFor(analysis(['SALES_COMMUNICATION', 'CUSTOMER_SERVICE'], ['ROLEPLAY']))), ['ROLEPLAY']);
  assert.deepEqual(types(planFor(analysis(['PRODUCT_KNOWLEDGE', 'SALES_COMMUNICATION'], ['PRODUCT_KNOWLEDGE']))), ['PRODUCT_KNOWLEDGE']);
  // the plan the builder shows is the same one
  assert.deepEqual(recommendedPlan(analysis(['PRODUCT_KNOWLEDGE'], ['PRODUCT_KNOWLEDGE'])).map((p) => [p.type, p.count, p.level, p.summary]), [['PRODUCT_KNOWLEDGE', 10, 2, '10 questions']]);
});

test('the rules text carries the master rules; role-play and call blocks appear only where they apply', () => {
  const quiz = rulesFor({ kind: 'COMPANY_STANDARD', type: 'QUIZ' });
  for (const phrase of ['REMEMBER -> RECOGNIZE -> APPLY -> RETAIN', '10-15 minutes', 'ONLY information supported by the training source', 'Do NOT write questions about which training resource', 'FINAL QUALITY CHECK', 'Avoid pure memorization', 'Do not give the answer away']) assert.ok(quiz.includes(phrase), phrase);
  assert.ok(!quiz.includes('ROLE-PLAY RULES'));
  assert.ok(!quiz.includes('CALL ANALYSIS PRINCIPLE'));
  const roleplay = rulesFor({ kind: 'SALES_COMMUNICATION', type: 'ROLEPLAY' });
  for (const phrase of ['ROLE-PLAY RULES', 'must NOT see', 'does not reveal information too easily', 'what they did well']) assert.ok(roleplay.includes(phrase), phrase);
  const call = rulesFor({ kind: 'CALL_IMPROVEMENT', type: 'ROLEPLAY' });
  assert.ok(call.includes('CALL ANALYSIS PRINCIPLE') && call.includes('Do NOT just ask what happened in the call'));
  assert.ok(rulesFor({ kind: 'PRODUCT_KNOWLEDGE', type: 'PRODUCT_KNOWLEDGE' }).includes('FULL source'));
  assert.ok(rulesFor({ kind: 'CALL_INDIVIDUAL', type: 'ROLEPLAY' }).includes('1-3 most important improvement areas'));
});

let org, admin, agent, cookies = {}, roleplay, course;
before(async () => {
  org = await prisma.organization.create({ data: { name: 'Practice rules tests' } });
  const mk = async (role, name) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `pr_${org.id}_${name}`, email: `pr_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); agent = await mk('TRAVEL_AGENT', 'agent');
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Rules course', createdById: admin.id, status: 'PUBLISHED', passingScore: 70 } });
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: agent.id } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);

test('generators receive the master rules for the kind of source', async () => {
  const productAnalysis = { classificationsJson: JSON.stringify(['PRODUCT_KNOWLEDGE']), extractedSkillsJson: '[]', criticalKnowledgeJson: '[]', practicalBehaviorsJson: '[]', commonMistakesJson: '[]', sourceReferencesJson: '{}' };
  seen.structured.length = 0;
  await generateQuestionAssessment({ course, analysis: productAnalysis, actor: admin, type: 'PRODUCT_KNOWLEDGE', level: 2, questionCount: 10 });
  const q = seen.structured.at(-1).systemInstruction;
  assert.ok(q.includes('MASTER GENERATION RULES') && q.includes('FINAL QUALITY CHECK') && q.includes('PRODUCT / AIRLINE KNOWLEDGE'));
  assert.ok(!q.includes('ROLE-PLAY RULES'));
  const salesAnalysis = { ...productAnalysis, classificationsJson: JSON.stringify(['SALES_COMMUNICATION']) };
  const made = await generateRoleplayAssessment({ course, analysis: salesAnalysis, actor: admin, level: 2, status: 'APPROVED' });
  const r = seen.structured.at(-1).systemInstruction;
  assert.ok(r.includes('ROLE-PLAY RULES') && r.includes('hiddenContext') && r.includes('expectedTechnique') && r.includes('SALES / COMMUNICATION'));
  const config = JSON.parse(made.configJson);
  assert.equal(config.hiddenContext, 'Budget is 2,500 USD and the real objection is the 24 hour layover.');
  assert.ok(!/price-sensitive/.test(made.title), 'the title does not give away the customer type');
  roleplay = await prisma.assessment.update({ where: { id: made.id }, data: { version: 1 } });
});

test('the learner never sees the hidden context or the expected technique; the AI customer and the scorer do', async () => {
  const page = await get(agent, `/assessments/${roleplay.id}/roleplay`);
  assert.equal(page.status, 200);
  assert.match(page.text, /A client calls about business class to Tokyo\./);
  assert.doesNotMatch(page.text, /2,500 USD|24 hour layover|Ask about budget and flexibility|price-sensitive/);
  const session = await prisma.practiceSession.findFirst({ where: { assessmentId: roleplay.id, profileId: agent.id } });
  seen.text.length = 0;
  const reply = await post(agent, `/assessments/${roleplay.id}/roleplay/message`, { sessionId: session.id, message: 'Hello! When would you like to travel?' });
  assert.equal(reply.status, 200);
  const customer = seen.text.at(-1).systemInstruction;
  assert.ok(customer.includes('2,500 USD') && /never volunteer/.test(customer) && /Do not reveal information too easily/.test(customer));
  assert.ok(!seen.text.at(-1).contents.some((c) => JSON.stringify(c).includes('2,500')), 'the hidden facts are in the instruction, not the conversation');
  seen.structured.length = 0;
  const finished = await post(agent, `/assessments/${roleplay.id}/roleplay/finish`, { sessionId: session.id });
  assert.equal(finished.status, 200);
  const scorer = seen.structured.at(-1).systemInstruction;
  assert.ok(scorer.includes('Expected technique') && scorer.includes('Ask about budget and flexibility before quoting.') && scorer.includes('"didWell"'));
  // the debrief: did well, missed, approach used, what would have worked better, one actionable step
  for (const text of ['What you did well', 'Asked about dates', 'What you missed', 'Never asked the budget', 'The approach you used', 'Product-first selling', 'What would have worked better', 'Asking about budget and flexibility first.', 'Next time:', 'Ask the budget in your first three questions.']) assert.ok(finished.text.includes(text), text);
  assert.doesNotMatch(finished.text, /2,500 USD|24 hour layover/);
  // and it is still there when the result is opened again
  const again = await get(agent, `/assessments/${roleplay.id}/result`);
  assert.equal(again.status, 200);
  for (const text of ['What you did well', 'Never asked the budget', 'Product-first selling', 'Ask the budget in your first three questions.']) assert.ok(again.text.includes(text), text);
});

test('an Admin can read and edit the hidden fields; saving the form without them never wipes them', async () => {
  const detail = await get(admin, `/admin/assessments/${roleplay.id}`);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Hidden customer context/); assert.match(detail.text, /Budget is 2,500 USD/);
  const body = { title: 'Rules role-play', level: '2', passingScore: '70', customerPersonality: 'calm', scenarioBrief: 'A client calls about business class to Tokyo.', openingLine: 'Hello?', rubricSkills: 'Discovery\nClosing\nOpening' };
  assert.equal((await post(admin, `/admin/assessments/${roleplay.id}/update`, body)).status, 302);
  assert.equal(JSON.parse((await prisma.assessment.findUnique({ where: { id: roleplay.id } })).configJson).hiddenContext, 'Budget is 2,500 USD and the real objection is the 24 hour layover.');
  assert.equal((await post(admin, `/admin/assessments/${roleplay.id}/update`, { ...body, hiddenContext: 'Budget is 3,000 USD.', expectedTechnique: 'Qualify first.' })).status, 302);
  const config = JSON.parse((await prisma.assessment.findUnique({ where: { id: roleplay.id } })).configJson);
  assert.equal(config.hiddenContext, 'Budget is 3,000 USD.'); assert.equal(config.expectedTechnique, 'Qualify first.');
});
