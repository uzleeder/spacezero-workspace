'use strict';
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { advanceProgress } = require('../lib/mediaProgress');
let failure = false, aiCalls = 0;
mock.method(require('../lib/aiMedia'), 'withAiMedia', async (_path, _mime, run) => run({ text: 'test audio' }));
mock.method(require('../lib/gemini'), 'generateStructured', async input => {
  aiCalls++;
  if (failure) throw new Error('Provider unavailable');
  if (input.responseSchema.properties.segments) return { data: { segments: [{ seconds: 0, speaker: 'Agent', text: 'Which travel dates work best?' }] } };
  if (input.responseSchema.properties.strengths) return { modelVersion: 'test', data: { title: 'Discovery practice', summary: 'Verify travel dates before recommending.', strengths: ['Asked dates'], weaknesses: ['Confirm flexibility'], objectives: ['Confirm constraints'], skills: [{ name: 'Discovery', score: 82, evidence: 'Asked about dates' }], moments: [], practices: ['ROLEPLAY'] } };
  return { data: { overallScore: 82, skillScores: [{ skill: 'Discovery', score: 82 }], feedback: 'Asked relevant questions. Confirm flexibility next.', transcript: 'Which travel dates work best?' } };
});
const { runCallBatch } = require('../lib/callIntelligence');
const { validateGraph } = require('../lib/processSimulation');
const app = require('../server');
let org, admin, agent, outsider, supervisor, cookies = {}, course, recipient;
function wav() {
  const data = Buffer.alloc(44 + 16000); data.write('RIFF'); data.writeUInt32LE(data.length - 8,4); data.write('WAVEfmt ',8); data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(1,22); data.writeUInt32LE(8000,24); data.writeUInt32LE(16000,28); data.writeUInt16LE(2,32); data.writeUInt16LE(16,34); data.write('data',36); data.writeUInt32LE(16000,40); return data;
}
before(async () => {
  org = await prisma.organization.create({ data: { name: 'Phase 2 tests' } });
  const otherOrg = await prisma.organization.create({ data: { name: 'Other phase 2 tests' } });
  async function user(role, name, organizationId = org.id) {
    const p = await prisma.profile.create({ data: { organizationId, fullName: name, username: `${org.id}_${name}`, email: `${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const token = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${token.raw}`; return p;
  }
  admin = await user('ADMIN','admin'); agent = await user('TRAVEL_AGENT','agent'); supervisor = await user('SUPERVISOR','supervisor'); outsider = await user('ADMIN','outsider',otherOrg.id);
  course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Phase 2 course', createdById: admin.id, status: 'PUBLISHED' } });
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } });
  recipient = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: agent.id } });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

test('anti-skip refuses forward jumps and excessive speed; rewind preserves coverage', () => {
  const now = new Date(); const row = { watchedRangesJson: '[[0,12]]', lastActivityAt: new Date(now - 5000), completedAt: null };
  assert.throws(() => advanceProgress(row, { position: 60, speed: 1, action: 'tick' }, 100, now));
  assert.throws(() => advanceProgress(row, { position: 14, speed: 2, action: 'tick' }, 100, now));
  assert.throws(() => advanceProgress(row, { position: 16, speed: 1, action: 'start' }, 100, now));
  assert.equal(advanceProgress(row, { position: 5, speed: 1, action: 'tick' }, 100, now).watchedRangesJson, '[[0,12]]');
  assert.equal(advanceProgress(row, { position: 18, speed: 1.2, action: 'tick' }, 100, now).percentComplete, 18);
  row.lastActivityAt = new Date(now - 3600000);
  assert.throws(() => advanceProgress(row, { position: 100, speed: 1, action: 'tick' }, 100, now));
});
test('mandatory media blocks direct assessment requests and manual completion', async () => {
  const module = await prisma.trainingModule.create({ data: { courseId: course.id, title: 'Required audio', contentType: 'AUDIO', storagePath: 'training/none.mp3', sourceRefJson: '{"durationSeconds":60}' } });
  const assessment = await prisma.assessment.create({ data: { courseId: course.id, organizationId: org.id, createdById: admin.id, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', status: 'APPROVED', title: 'Locked quiz' } });
  for (const [method,url] of [['get',`/assessments/${assessment.id}/take`],['post',`/assessments/${assessment.id}/submit`],['post',`/training/${recipient.id}/complete`]]) assert.equal((await request(app)[method](url).set('Cookie',cookies[agent.id])).status,403);
  assert.equal((await request(app).post(`/training-media/${module.id}/progress`).set('Cookie',cookies[outsider.id]).send({ position:60,speed:1 })).status,404);
  await prisma.trainingModule.update({where:{id:module.id},data:{required:false}});
});
test('batch upload rejects duplicates and unauthorized users', async () => {
  assert.equal((await request(app).post('/ai-practice/calls').set('Cookie',cookies[agent.id])).status,403);
  const result = await request(app).post('/ai-practice/calls').set('Cookie',cookies[admin.id]).field('mode','BEST_PRACTICE').field('authorized','yes').attach('calls',wav(),{filename:'one.wav',contentType:'audio/wav'}).attach('calls',wav(),{filename:'two.wav',contentType:'audio/wav'});
  assert.equal(result.status,400); assert.match(result.text,/same recording/);
});
test('call pipeline preserves failure state, retries, and requires human approval', async () => {
  const uploaded = await request(app).post('/ai-practice/calls').set('Cookie',cookies[admin.id]).attach('calls',wav(),{filename:'call.wav',contentType:'audio/wav'});
  assert.equal(uploaded.status,302);
  const id = new URL(uploaded.headers.location,'http://x').searchParams.get('saved');
  assert.equal((await prisma.callBatch.findUnique({where:{id}})).analysisRequestedAt,null); // saved, not analyzed
  assert.equal((await request(app).post(`/ai-practice/calls/${id}/analyze`).set('Cookie',cookies[admin.id]).type('form').send({purpose:'BEST_PRACTICE',authorized:'yes'})).status,302);
  for (const p of [outsider,supervisor,agent]) assert.ok([403,404].includes((await request(app).get(`/ai-practice/calls/${id}`).set('Cookie',cookies[p.id])).status));
  failure = true; await runCallBatch(id); failure = false;
  assert.equal((await prisma.callBatch.findUnique({where:{id}})).status,'FAILED');
  await runCallBatch(id);
  const ready = await prisma.callBatch.findUnique({where:{id}});
  assert.equal(ready.status,'READY_FOR_REVIEW'); assert.equal(ready.generatedCourseId,null);
  const review = await request(app).get(`/ai-practice/calls/${id}`).set('Cookie',cookies[admin.id]); assert.equal(review.status,200); assert.match(review.text,/Review and customize/);
  const approved = await request(app).post(`/ai-practice/calls/${id}/approve`).set('Cookie',cookies[admin.id]).type('form').send({methods:'ROLEPLAY',title:'Reviewed call',summary:'Confirm dates.'});
  assert.equal(approved.status,302);
  const batch = await prisma.callBatch.findUnique({where:{id},include:{generatedCourse:true}}); assert.equal(batch.generatedCourse.status,'DRAFT');
  assert.equal((await request(app).post(`/ai-practice/calls/${id}/approve`).set('Cookie',cookies[admin.id]).type('form').send({methods:'ROLEPLAY'})).status,409);
});
test('voice response records a scored attempt without trusting a client score', async () => {
  const assessment = await prisma.assessment.create({data:{courseId:course.id,organizationId:org.id,createdById:admin.id,createdVia:'ADMIN_MANUAL',type:'VOICE',status:'APPROVED',title:'Voice',configJson:JSON.stringify({scenarioBrief:'Ask travel dates',rubricSkills:['Discovery']})}});
  const beforeCalls = aiCalls;
  const response = await request(app).post(`/assessments/${assessment.id}/voice`).set('Cookie',cookies[agent.id]).field('authorized','yes').field('score','100').attach('recording',wav(),{filename:'voice.wav',contentType:'audio/wav'});
  assert.equal(response.status,200); assert.ok(aiCalls>beforeCalls);
  const attempt = await prisma.trainingAttempt.findFirst({where:{assessmentId:assessment.id}}); assert.equal(attempt.score,82); assert.equal(attempt.status,'COMPLETED');
});
test('workflow graphs reject missing nodes and cycles', () => {
  const node = id => ({id,situation:'Situation',options:[{label:'A',nextId:null,score:100,feedback:'Correct'},{label:'B',nextId:null,score:0,feedback:'Try another action'}]});
  const config={startId:'a',skills:['Process'],nodes:[node('a'),node('b'),node('c')]};
  config.nodes[0].options[0].nextId='missing'; assert.throws(()=>validateGraph(config));
  config.nodes[0].options[0].nextId='a'; assert.throws(()=>validateGraph(config));
  config.nodes[0].options[0].nextId='b'; assert.equal(validateGraph(config).nodes.length,3);
});
