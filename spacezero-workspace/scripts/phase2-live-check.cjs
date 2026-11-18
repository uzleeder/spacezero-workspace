'use strict';
// Live Phase 2 acceptance run (tests A-G) against the REAL Gemini API, on a throw-away database.
//   npm run test:live
// It spends a small amount of Gemini quota. Nothing here touches the application database:
// it creates a temporary SQLite file and a temporary storage folder, and deletes them afterwards.
//
// Sources are generated on the spot: spoken lessons and customer calls are synthesized with the
// Windows text-to-speech voices, so real audio goes through the real transcription/analysis path.
// A real training VIDEO or PDF is not synthesized here — those go through the same pipeline but
// should be spot-checked by hand with your own files (see the Phase 2 report).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

if (!process.argv.includes('--child')) {
  // Minimal .env reader (KEY=VALUE lines), so the real Gemini key is picked up without any extra dependency.
  try {
    for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* no .env file */ }
  if (!process.env.GEMINI_API_KEY) { console.error('GEMINI_API_KEY is not set (.env).'); process.exit(1); }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-live-'));
  fs.writeFileSync(path.join(folder, 'live.db'), '');
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: `file:${path.join(folder, 'live.db').replaceAll('\\', '/')}`, STORAGE_ROOT: path.join(folder, 'storage'), LIVE_DIR: folder, CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') };
  for (const key of ['SMTP_HOST', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_PORT']) delete env[key];
  const run = (args) => spawnSync(process.execPath, args, { env, stdio: 'inherit', cwd: root });
  let status = run([path.join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy']).status;
  if (status === 0) status = run([__filename, '--child']).status;
  fs.rmSync(folder, { recursive: true, force: true });
  process.exit(status || 0);
}

// ------------------------------------------------------------------ child: the actual checks
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { enqueueAnalysis, runPipeline } = require('../lib/trainingAnalysis');
const { runCallBatch } = require('../lib/callIntelligence');
const app = require('../server');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
const section = (title) => console.log(`\n=== ${title}`);
const lower = (v) => JSON.stringify(v ?? '').toLowerCase();

// ---- speech synthesis (Windows SAPI) -> one 16 kHz mono WAV per conversation
function synthesize(lines, outFile) {
  const dir = fs.mkdtempSync(path.join(process.env.LIVE_DIR, 'tts-'));
  const spec = path.join(dir, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify(lines.map((l, i) => ({ voice: l.voice, text: l.text, file: path.join(dir, `part${i}.wav`) }))));
  const ps = `
Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$items = Get-Content -Raw -LiteralPath '${spec.replaceAll("'", "''")}' | ConvertFrom-Json
foreach ($it in $items) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SelectVoice($it.voice)
  $s.Rate = 1
  $s.SetOutputToWaveFile($it.file, $fmt)
  $s.Speak($it.text)
  $s.Dispose()
}`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('speech synthesis failed: ' + r.stderr);
  const chunks = [];
  const gap = Buffer.alloc(16000 * 2 * 0.5); // half a second of silence between speakers
  for (let i = 0; i < lines.length; i++) {
    const buf = fs.readFileSync(path.join(dir, `part${i}.wav`));
    let pos = 12;
    while (pos < buf.length - 8) {
      const id = buf.toString('ascii', pos, pos + 4); const size = buf.readUInt32LE(pos + 4);
      if (id === 'data') { chunks.push(buf.subarray(pos + 8, pos + 8 + size), gap); break; }
      pos += 8 + size;
    }
  }
  const data = Buffer.concat(chunks);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(outFile, Buffer.concat([header, data]));
  fs.rmSync(dir, { recursive: true, force: true });
  return { seconds: Math.round(data.length / 32000) };
}
const A = 'Microsoft David Desktop'; const C = 'Microsoft Zira Desktop';

const LESSON = [{ voice: A, text: 'Welcome to Keeping Premium Clients on the Line. Premium travelers are busy and they compare us with other agencies while we talk. Your job is to keep them engaged and to lead the call. Rule one. Open with the client name and the purpose of the call, then ask two discovery questions before you ever mention a price. Ask what matters more, schedule flexibility or price, and who is travelling. Rule two. When the client says the price is too high, never discount first. Acknowledge the concern, restate the value of the routing and the cabin, and ask which part of the price worries them. Rule three. Always close with a clear next step. For example, say, I will hold this fare until five p.m. today, shall I send the itinerary to your email now? A call that ends with maybe later is a lost call.' }];
const NOTES = 'Extra coaching notes: the five-second silence rule. If the client has been silent for more than five seconds, ask an engagement question such as "What would make this trip perfect for you?" Never fill silence with a discount. Log every promised follow-up in the CRM the same day.';
const SABRE = 'Company SOP: Mixed cabin itineraries in Sabre. Step 1: search availability with the availability entry, for example 1 15OCT JFK LHR, and note the booking class per segment. Step 2: sell the first segment in class J, then sell the return or second segment in the class that matches the cabin the client chose; a mixed cabin means a different class letter per segment. Step 3: price the itinerary with the pricing entry and check that every segment shows the intended cabin. Step 4: if a segment shows the wrong cabin, cancel that segment and re-sell it with the correct class before pricing again. Step 5: never ticket before the fare rules for the mixed cabin have been read. Common mistake: pricing before validating the cabin on every segment. Decision point: if Business class is not available on the second segment, offer Premium Economy on that segment only after the client agrees.';
const AIRCRAFT = 'Product guide. Boeing 787-9 Business Class: 1-2-1 layout, every seat has direct aisle access, seats convert to a fully flat 78 inch bed, 18 inch screen. Airbus A330-300 Business Class on the same airline: 2-2-2 layout, seats recline to 180 degrees flat but the middle seats do not have direct aisle access, 15 inch screen. First Class on the Boeing 777-300ER: 1-2-1 with a closing door and a separate turn-down service. Lounge note: Business passengers use the main lounge; First passengers may use the private First lounge. Recommendation rule: for a couple travelling together, recommend the middle pair of the 1-2-1 layout only if they want to sit side by side; a solo business traveller who values privacy should get a window seat in the 1-2-1 cabin. Difference to explain to customers: the 787-9 has direct aisle access from every Business seat; the A330-300 does not.';

const CALL_SETS = {
  weak: [
    [
      [A, 'Good afternoon, Above9 Travel, this is Mark.'], [C, 'Hi, I need Business Class from Los Angeles to Tokyo in November, one connection is fine.'],
      [A, 'Sure. Are you travelling alone, and is your schedule flexible?'], [C, 'Alone, and I can move a day or two either way.'],
      [A, 'Great, I found a lovely Business fare on a modern aircraft with a lie flat seat for eight thousand two hundred dollars.'], [C, 'Hmm, that is more than I expected. It is a lot of money.'],
      [A, 'Oh, I can take two hundred off right away if that helps.'], [C, 'Still expensive. I will think about it.'],
      [A, 'Okay, no problem. Call us back if you decide.'], [C, 'Thanks, bye.'],
    ],
    [
      [A, 'Above9 Travel, Mark speaking.'], [C, 'Hello, I want First Class to London for two people next month.'],
      [A, 'Of course. Which dates, and do you prefer a daytime departure?'], [C, 'Departing on the tenth, daytime is best.'],
      [A, 'I can offer First Class on a Boeing 777 with a private suite for twenty eight thousand dollars total.'], [C, 'That is very high. My friend found something cheaper online.'],
      [A, 'I can give you a five percent discount straight away.'], [C, 'I need to compare. I will call you back.'],
      [A, 'Alright, feel free to call whenever.'],
    ],
    [
      [A, 'Thank you for calling Above9, Mark here.'], [C, 'Hi, Business Class to Sydney, leaving the second of December.'],
      [A, 'How many travellers, and do you care more about price or timing?'], [C, 'Just me. Timing matters most, I have a meeting on the fourth.'],
      [A, 'Then I recommend the direct flight in Business, it lands the evening before your meeting, eleven thousand dollars.'], [C, 'Ouch. That is too expensive for me.'],
      [A, 'I can reduce it by three hundred dollars if you book today.'], [C, 'I will think about it and let you know.'],
      [A, 'Sure, just call us when you are ready.'],
    ],
  ],
  best: [[
    [A, 'Good morning Mr Carter, this is Daniel at Above9 Travel, thank you for taking my call about your trip to Tokyo.'], [C, 'Yes, I only have a few minutes.'],
    [A, 'Understood, I will be quick. Two questions so I get this right. Is your schedule flexible, and what matters most, price, comfort or arrival time?'], [C, 'Honestly my schedule is flexible by a few days, and I need to arrive rested for a board meeting.'],
    [A, 'That is very helpful. Because you need to arrive rested and your dates can move, I recommend the fully flat seat on the direct routing, and a departure one day earlier saves you a rushed connection.'], [C, 'Okay, what does that cost?'],
    [A, 'The Business fare on the direct flight is twelve thousand dollars. Before we talk about the number, let me explain why this routing protects the meeting, you get eight hours of real sleep and no connection risk.'], [C, 'Twelve thousand is a lot. Can you do better?'],
    [A, 'I understand it is a significant investment. Which part concerns you most, the total, or whether it is worth it compared with a cheaper connecting flight?'], [C, 'The total, mostly. My assistant found an itinerary with a connection for eight thousand.'],
    [A, 'That one connects in Frankfurt with a tight ninety minute layover and no flat bed on the second leg, so you would arrive tired. If the meeting matters, the direct flight is the safer choice. I would rather keep your price and protect your trip than discount it.'], [C, 'That makes sense. I do not want to arrive exhausted.'],
    [A, 'Then here is the next step. I will hold this fare until five p.m. today. Shall I send the itinerary to your email now and call you at four to confirm?'], [C, 'Yes, please do. Send it now, and call me at four.'],
    [A, 'Perfect, it is on its way, and I have booked our call for four p.m. Thank you Mr Carter.'],
  ]],
};

async function login(profile) {
  const token = generateToken();
  await prisma.session.create({ data: { profileId: profile.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 7200000) } });
  return `sz_session=${token.raw}`;
}

async function main() {
  const org = await prisma.organization.create({ data: { name: 'Live acceptance' } });
  const mk = (role, name) => prisma.profile.create({ data: { organizationId: org.id, fullName: `Live ${name}`, username: `live_${name}`, email: `live_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
  const admin = await mk('ADMIN', 'admin'); const agent = await mk('TRAVEL_AGENT', 'agent');
  const adminCookie = await login(admin); const agentCookie = await login(agent);
  const skillNames = ['Discovery Questions', 'Call Control', 'Client Engagement', 'Product Knowledge', 'Aircraft Knowledge', 'Business Class Knowledge', 'First Class Knowledge', 'Objection Handling', 'Confidence', 'Closing', 'Follow-Up'];
  await prisma.skill.createMany({ data: [...skillNames.map((name, i) => ({ organizationId: org.id, roleKey: 'TRAVEL_AGENT', name, category: 'Sales Skills', displayOrder: i })), ...['Sabre Availability', 'Fare Search', 'Cabin Validation', 'Ticketing'].map((name, i) => ({ organizationId: org.id, roleKey: 'FLIGHT_EXPERT', name, category: 'Technical Skills', displayOrder: i }))] });
  const get = (url, cookie = adminCookie) => request(app).get(url).set('Cookie', cookie);
  const post = (url, body, cookie = adminCookie) => request(app).post(url).set('Cookie', cookie).type('form').send(body);

  const { saveUpload } = require('../lib/storage');
  const { probeMedia } = require('../lib/mediaProbe');
  async function courseWith(title, modules) {
    const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title, description: title, createdById: admin.id } });
    for (const [i, m] of modules.entries()) {
      let storagePath = null; let sourceRefJson = null;
      if (m.wav) {
        const buffer = fs.readFileSync(m.wav);
        storagePath = (await saveUpload({ buffer, originalname: 'lesson.wav', mimetype: 'audio/wav', size: buffer.length }, 'training')).storagePath;
        sourceRefJson = JSON.stringify({ durationSeconds: Math.ceil(await probeMedia(storagePath)) });
      }
      await prisma.trainingModule.create({ data: { courseId: course.id, title: m.title, contentType: m.type, description: m.text || null, storagePath, sourceRefJson, displayOrder: i } });
    }
    const analysis = await enqueueAnalysis(course.id);
    await runPipeline(analysis.id);
    const done = await prisma.trainingAnalysis.findUnique({ where: { courseId: course.id } });
    return { course, analysis: done, classes: JSON.parse(done.classificationsJson || '[]'), methods: JSON.parse(done.recommendedMethodsJson || '[]'), refs: JSON.parse(done.sourceReferencesJson || '{}') };
  }
  async function generate(course, methods, level = 3) {
    await post(`/admin/training/${course.id}/analysis/approve`, {});
    const approved = await prisma.trainingAnalysis.findUnique({ where: { courseId: course.id } });
    if (approved.status !== 'APPROVED') { check('analysis could be approved before generating practice', false, `status ${approved.status}: ${approved.errorMessage || ''}`); return { status: 0, list: [] }; }
    const res = await post(`/admin/training/${course.id}/practice-plan`, { methods, level: String(level) });
    return { status: res.status, list: await prisma.assessment.findMany({ where: { courseId: course.id }, include: { questions: { orderBy: { displayOrder: 'asc' } } } }) };
  }

  // ------------------------------------------------------------------ TEST A + D
  section('TEST A / D — spoken sales lesson (audio) + written notes, one training package');
  const lessonWav = path.join(process.env.LIVE_DIR, 'lesson.wav');
  const spoken = synthesize(LESSON, lessonWav);
  console.log(`(synthesized lesson: ${spoken.seconds}s)`);
  const sales = await courseWith('Keeping Premium Clients on the Line', [{ title: 'Spoken lesson', type: 'AUDIO', wav: lessonWav }, { title: 'Coaching notes', type: 'NOTE', text: NOTES }]);
  console.log('status:', sales.analysis.status, '| classifications:', sales.classes.join(', '), '| methods:', sales.methods.join(', '), '| intensity:', sales.analysis.recommendedIntensityJson);
  check('A: analysis completed', sales.analysis.status === 'READY_FOR_REVIEW', sales.analysis.errorMessage || '');
  check('A: classified as Sales / Communication', sales.classes.includes('SALES_COMMUNICATION'));
  check('A: recommends Quiz and Role-play', sales.methods.includes('QUIZ') && sales.methods.includes('ROLEPLAY'));
  check('A: recommends voice or scenario practice', sales.methods.includes('VOICE') || sales.methods.includes('PROCESS_SIM'));
  check('A: recommends practice beyond a plain quiz', sales.methods.filter((m) => m !== 'QUIZ').length >= 1);
  const knowledge = lower([sales.analysis.criticalKnowledgeJson, sales.analysis.practicalBehaviorsJson, sales.analysis.objectivesJson]);
  check('A: knowledge reflects the AUDIO lesson (discount / next step / two discovery questions)', /discount/.test(knowledge) && /next step|hold this fare/.test(knowledge) && /discovery|two questions/.test(knowledge));
  check('D: knowledge ALSO reflects the written NOTES (five-second silence rule)', /five|5|silence/.test(knowledge) && /silence/.test(knowledge));
  check('D: both sources are part of the package', (sales.refs.sources || []).length === 2);
  const g1 = await generate(sales.course, ['QUIZ', 'ROLEPLAY', 'VOICE'], 4);
  const quiz = g1.list.find((a) => a.type === 'QUIZ');
  check('A: quiz, role-play and voice practice were generated for review (not auto-approved)', g1.status === 302 && ['QUIZ', 'ROLEPLAY', 'VOICE'].every((t) => g1.list.some((a) => a.type === t && a.status === 'AI_GENERATED')));
  const quizText = lower(quiz?.questions.map((q) => [q.prompt, q.optionsJson, q.correctAnswerJson]));
  check('A: quiz questions come from the video/audio content (price objection / next step / discovery)', /discount|price|next step|discovery|value/.test(quizText));
  check('D: quiz also uses the written notes (silence)', /silen|five|engag/.test(quizText));
  check('A: questions are practical (scenario or application, not only definitions)', (quiz?.questions || []).some((q) => /client|customer|traveler|traveller|caller/i.test(q.prompt)));
  check('A: AI source check ran on the generated practice', Boolean(JSON.parse(quiz?.configJson || '{}').validation));
  console.log('sample question:', quiz?.questions[0]?.prompt);
  const roleplay = g1.list.find((a) => a.type === 'ROLEPLAY');
  const rpConfig = JSON.parse(roleplay?.configJson || '{}');
  check('A: role-play has a customer personality, scenario, opening line and rubric', rpConfig.customerPersonality && rpConfig.scenarioBrief && rpConfig.openingLine && (rpConfig.rubricSkills || []).length >= 3);
  console.log('role-play customer:', rpConfig.customerPersonality, '|', rpConfig.openingLine);

  // ------------------------------------------------------------------ TEST B
  section('TEST B — Sabre / GDS technical training');
  const sabre = await courseWith('Sabre mixed cabin', [{ title: 'Sabre SOP', type: 'NOTE', text: SABRE }]);
  console.log('classifications:', sabre.classes.join(', '), '| methods:', sabre.methods.join(', '));
  check('B: analysis completed', sabre.analysis.status === 'READY_FOR_REVIEW', sabre.analysis.errorMessage || '');
  check('B: classified as Technical and/or Process, NOT plain sales', (sabre.classes.includes('TECHNICAL') || sabre.classes.includes('PROCESS_SOP')) && !(sabre.classes.length === 1 && sabre.classes[0] === 'SALES_COMMUNICATION'));
  check('B: recommends technical / process practice', sabre.methods.includes('TECHNICAL') || sabre.methods.includes('PROCESS_SIM'));
  check('B: does not recommend role-play as the main method', !(sabre.methods[0] === 'ROLEPLAY'));
  const g2 = await generate(sabre.course, ['TECHNICAL', 'PROCESS_SIM'], 4);
  const tech = g2.list.find((a) => a.type === 'TECHNICAL');
  const techText = lower(tech?.questions.map((q) => [q.type, q.prompt, q.optionsJson, q.correctAnswerJson]));
  check('B: technical questions test workflow application (cabin / class / pricing / segment)', /segment|cabin|class|pricing|price|sell|availability/.test(techText) && (tech?.questions || []).some((q) => ['ORDERING', 'SCENARIO', 'SHORT_ANSWER', 'MCQ'].includes(q.type)));
  console.log('sample technical question:', tech?.questions[0]?.type, '|', tech?.questions[0]?.prompt);

  // ------------------------------------------------------------------ TEST C
  section('TEST C — aircraft / cabin material');
  const product = await courseWith('Aircraft and cabins', [{ title: 'Cabin guide', type: 'NOTE', text: AIRCRAFT }]);
  console.log('classifications:', product.classes.join(', '), '| methods:', product.methods.join(', '));
  check('C: analysis completed', product.analysis.status === 'READY_FOR_REVIEW', product.analysis.errorMessage || '');
  check('C: classified as Product Knowledge', product.classes.includes('PRODUCT_KNOWLEDGE'));
  check('C: recommends product-knowledge practice', product.methods.includes('PRODUCT_KNOWLEDGE') || product.methods.includes('QUIZ'));
  const g3 = await generate(product.course, ['PRODUCT_KNOWLEDGE'], 3);
  const prod = g3.list.find((a) => a.type === 'PRODUCT_KNOWLEDGE');
  const prodText = lower(prod?.questions.map((q) => [q.prompt, q.optionsJson, q.correctAnswerJson]));
  check('C: questions compare aircraft / cabins from the guide', /787|a330|777|1-2-1|2-2-2|aisle/.test(prodText));
  check('C: includes a customer recommendation scenario', (prod?.questions || []).some((q) => /recommend|traveller|traveler|client|customer|couple|solo/i.test(q.prompt)));
  console.log('sample product question:', prod?.questions[0]?.prompt);

  // ------------------------------------------------------------------ TEST E
  section('TEST E — several real-style customer calls for ONE agent (Individual Agent Improvement)');
  const files = CALL_SETS.weak.map((lines, i) => { const f = path.join(process.env.LIVE_DIR, `weak${i}.wav`); const r = synthesize(lines.map(([voice, text]) => ({ voice, text })), f); console.log(`(call ${i + 1}: ${r.seconds}s)`); return f; });
  let up = request(app).post('/ai-practice/calls').set('Cookie', adminCookie).field('mode', 'INDIVIDUAL_AGENT').field('authorized', 'yes').field('targetAgentId', agent.id);
  for (const f of files) up = up.attach('calls', fs.readFileSync(f), { filename: path.basename(f), contentType: 'audio/wav' });
  const upRes = await up;
  check('E: batch of calls uploaded', upRes.status === 302, upRes.text.slice(0, 120));
  const batchId = upRes.headers.location.split('/')[3];
  await runCallBatch(batchId);
  const batch = await prisma.callBatch.findUnique({ where: { id: batchId }, include: { recordings: true } });
  const report = JSON.parse(batch.aggregatedAnalysisJson || '{}');
  console.log('batch status:', batch.status, batch.errorMessage || '');
  console.log('strengths:', (report.strengths || []).join(' | '));
  console.log('weaknesses:', (report.weaknesses || []).join(' | '));
  console.log('skills:', (report.skills || []).map((s) => `${s.name}=${s.score}`).join(', '));
  console.log('practices:', (report.practices || []).join(', '));
  check('E: every call was transcribed', batch.recordings.length === 3 && batch.recordings.every((r) => r.status === 'TRANSCRIBED' && r.transcriptText));
  check('E: batch reached READY_FOR_REVIEW', batch.status === 'READY_FOR_REVIEW');
  const transcript = lower(batch.recordings.map((r) => r.transcriptText));
  check('E: transcripts contain the actual conversation', /discount|tokyo|london|sydney/.test(transcript));
  check('E: repeated WEAKNESS identified (objection handling / discounting / closing)', /objection|discount|clos|next step|price/.test(lower(report.weaknesses)));
  check('E: repeated STRENGTH identified (discovery)', /discover|question|rapport|professional/.test(lower(report.strengths)));
  const mapped = (report.skills || []).filter((s) => skillNames.includes(s.name));
  check('E: findings map to real Skill Graph skills', mapped.length >= 2, mapped.map((s) => s.name).join(', '));
  const weak = mapped.find((s) => s.name === 'Objection Handling') || mapped.find((s) => s.name === 'Closing');
  check('E: the weak skill scores low (0-100 scale)', weak && weak.score <= 60, weak ? `${weak.name}=${weak.score}` : 'not found');
  check('E: personalized practice recommended (role-play / voice / scenario)', (report.practices || []).some((p) => ['ROLEPLAY', 'VOICE', 'PROCESS_SIM'].includes(p)));
  check('E: nothing reached the Skill Graph before human review', (await prisma.skillEvidence.count({ where: { sourceId: batchId } })) === 0);
  const approve = await post(`/ai-practice/calls/${batchId}/approve`, { methods: (report.practices || ['ROLEPLAY']).slice(0, 3) });
  check('E: Admin approves the reviewed recommendations', approve.status === 302);
  const evidence = await prisma.skillEvidence.findMany({ where: { sourceId: batchId }, include: { employeeSkill: { include: { skill: true } } } });
  check('E: approved analysis became CALL_REVIEW evidence for that agent only', evidence.length > 0 && evidence.every((e) => e.sourceType === 'CALL_REVIEW' && e.employeeSkill.profileId === agent.id), `${evidence.length} evidence rows`);
  const callCourse = (await prisma.callBatch.findUnique({ where: { id: batchId } })).generatedCourseId;
  check('E: a personalized training draft exists for review', Boolean(callCourse));
  const g4 = await generate({ id: callCourse }, ['ROLEPLAY', 'QUIZ'], 4);
  check('E: personalized practice generated for review', g4.list.length >= 1 && g4.list.every((a) => a.status === 'AI_GENERATED'));

  // ---- review -> approve -> send to training -> assign to the agent -> appears on their dashboard
  for (const a of g4.list) await post(`/admin/assessments/${a.id}/approve`, {});
  await post(`/admin/training/${callCourse}/send-to-training`, {});
  const assign = await post('/assignments', { courseId: callCourse, scope: 'INDIVIDUAL', targetProfileIds: [agent.id], minimumScore: '70' });
  check('E: Admin assigns the personalized practice to the agent', assign.status === 302);
  const myTraining = await get('/training', agentCookie);
  check('E: the assigned practice appears in the agent\'s My Training', myTraining.status === 200 && (await prisma.trainingAssignmentRecipient.count({ where: { profileId: agent.id } })) === 1);

  // ------------------------------------------------------------------ TEST F
  section('TEST F — best-practice / training call');
  const bestFile = path.join(process.env.LIVE_DIR, 'best.wav');
  const bestAudio = synthesize(CALL_SETS.best[0].map(([voice, text]) => ({ voice, text })), bestFile);
  console.log(`(best-practice call: ${bestAudio.seconds}s)`);
  const upBest = await request(app).post('/ai-practice/calls').set('Cookie', adminCookie).field('mode', 'BEST_PRACTICE').field('authorized', 'yes').attach('calls', fs.readFileSync(bestFile), { filename: 'best.wav', contentType: 'audio/wav' });
  const bestId = upBest.headers.location.split('/')[3];
  await runCallBatch(bestId);
  const best = await prisma.callBatch.findUnique({ where: { id: bestId }, include: { recordings: true } });
  const bestReport = JSON.parse(best.aggregatedAnalysisJson || '{}');
  console.log('status:', best.status, best.errorMessage || '');
  console.log('summary:', bestReport.summary);
  console.log('moments:', (bestReport.moments || []).map((m) => `${m.seconds}s ${m.observation}`).join(' || '));
  console.log('skills:', (bestReport.skills || []).map((s) => `${s.name}=${s.score}`).join(', '));
  check('F: call analyzed and ready for review', best.status === 'READY_FOR_REVIEW');
  check('F: explains WHY the call worked (summary + strengths)', (bestReport.summary || '').length > 60 && (bestReport.strengths || []).length >= 2);
  check('F: timestamped key moments tied to the recording', (bestReport.moments || []).length >= 3 && bestReport.moments.every((m) => best.recordings.some((r) => r.id === m.recordingId) && m.seconds >= 0 && m.seconds <= (best.recordings[0].durationSeconds || 9999)));
  check('F: techniques identified (discovery / value / objection / next step)', /discover|question/.test(lower(bestReport)) && /objection|discount|price/.test(lower(bestReport)) && /next step|clos|hold/.test(lower(bestReport)));
  check('F: skills demonstrated are mapped', (bestReport.skills || []).filter((s) => skillNames.includes(s.name)).length >= 3);
  check('F: nothing is training until a human approves', (await prisma.trainingCourse.count({ where: { generatedFromCallBatches: { some: { id: bestId } } } })) === 0);
  const approveBest = await post(`/ai-practice/calls/${bestId}/approve`, { methods: ['QUIZ', 'ROLEPLAY'] });
  check('F: Admin reviews and approves', approveBest.status === 302);
  const bestCourse = (await prisma.callBatch.findUnique({ where: { id: bestId } })).generatedCourseId;
  check('F: a reusable training package is created as a DRAFT', (await prisma.trainingCourse.findUnique({ where: { id: bestCourse } })).status === 'DRAFT');
  check('F: no skill evidence for a best-practice call', (await prisma.skillEvidence.count({ where: { sourceId: bestId } })) === 0);
  const g5 = await generate({ id: bestCourse }, ['QUIZ', 'ROLEPLAY'], 4);
  check('F: quiz + role-play generated from the call for review', g5.list.some((a) => a.type === 'QUIZ') && g5.list.some((a) => a.type === 'ROLEPLAY'));
  const unassignable = await post('/assignments', { courseId: bestCourse, scope: 'INDIVIDUAL', targetProfileIds: [agent.id] });
  check('F: an unapproved draft cannot be assigned', unassignable.status === 403 || unassignable.status === 404 || (await prisma.trainingAssignment.count({ where: { courseId: bestCourse } })) === 0);
  for (const a of g5.list) await post(`/admin/assessments/${a.id}/approve`, {});
  await post(`/admin/training/${bestCourse}/send-to-training`, {});
  check('F: after approval the training can be assigned to other employees', (await post('/assignments', { courseId: bestCourse, scope: 'ROLE', targetRole: 'TRAVEL_AGENT' })).status === 302 && (await prisma.trainingAssignment.count({ where: { courseId: bestCourse } })) === 1);

  // ------------------------------------------------------------------ TEST G
  section('TEST G — failure, smart retake, pass; every attempt kept');
  const target = (await prisma.assessment.findFirst({ where: { courseId: bestCourse, type: 'QUIZ' }, include: { questions: { orderBy: { displayOrder: 'asc' } } } }));
  if (!target) { check('G: a quiz exists to take', false); throw new Error('no quiz generated for the best-practice training'); }
  const answersFor = (questions, correctCount) => Object.fromEntries(questions.map((q, i) => {
    const correct = JSON.parse(q.correctAnswerJson);
    return [`q_${q.id}`, i < correctCount ? correct : (q.type === 'SHORT_ANSWER' ? 'no idea' : (JSON.parse(q.optionsJson || '[]').find((o) => o !== correct) || 'wrong'))];
  }));
  const total = target.questions.length;
  const failing = Math.max(0, Math.ceil(total * 0.5) - 1);
  const first = await request(app).post(`/assessments/${target.id}/submit`).set('Cookie', agentCookie).type('form').send(answersFor(target.questions, failing));
  const attempts1 = await prisma.trainingAttempt.findMany({ where: { profileId: agent.id, assessmentId: target.id }, orderBy: { attemptNumber: 'asc' } });
  console.log(`(answered ${failing}/${total} correctly) status: ${first.status}; attempt score: ${attempts1[0]?.score}`);
  check('G: first attempt scored below 70 and is FAILED — RETAKE REQUIRED', attempts1.length === 1 && attempts1[0].score < 70 && attempts1[0].status === 'RETAKE_REQUIRED');
  check('G: the result page says retake required', /retake/i.test(first.text));
  const breakdown = JSON.parse(attempts1[0].skillBreakdownJson || '{}');
  console.log('skill breakdown:', JSON.stringify(breakdown));
  check('G: weak skills were identified from the attempt', Object.keys(breakdown).length > 0 && Object.values(breakdown).some((v) => v < 70));
  const remediate = await request(app).post(`/assessments/${target.id}/remediate`).set('Cookie', agentCookie);
  check('G: targeted remediation was created', remediate.status === 302 && /\/assessments\/[^/]+\/(take|roleplay)/.test(remediate.headers.location), remediate.headers.location);
  const retakeId = remediate.headers.location.split('/')[2];
  const retake = await prisma.assessment.findUnique({ where: { id: retakeId }, include: { questions: { orderBy: { displayOrder: 'asc' } } } });
  const focus = JSON.parse(retake.configJson).focusSkills;
  console.log('remediation focus skills:', focus.join(', '), '| questions:', retake.questions.length);
  check('G: remediation targets ONLY the weak skills, not the ones already passed', focus.length > 0 && focus.every((s) => breakdown[s] !== undefined && breakdown[s] < 70));
  check('G: remediation is new material, not the same test again', retake.id !== target.id && retake.questions.every((q) => !target.questions.some((o) => o.prompt === q.prompt)));
  const secondSubmit = await request(app).post(`/assessments/${retake.id}/submit`).set('Cookie', agentCookie).type('form').send(answersFor(retake.questions, retake.questions.length));
  const retakeAttempts = await prisma.trainingAttempt.findMany({ where: { profileId: agent.id, assessmentId: retake.id } });
  console.log(`retake attempt score: ${retakeAttempts[0]?.score} status: ${retakeAttempts[0]?.status} (http ${secondSubmit.status})`);
  check('G: the new practice passes (>= 70) and is COMPLETED', retakeAttempts.length === 1 && retakeAttempts[0].score >= 70 && retakeAttempts[0].status === 'COMPLETED');
  check('G: BOTH attempts stay in history', (await prisma.trainingAttempt.count({ where: { profileId: agent.id, assessmentId: { in: [target.id, retake.id] } } })) === 2);
  const evid = await prisma.skillEvidence.findMany({ where: { employeeSkill: { profileId: agent.id }, sourceType: { in: ['ASSESSMENT', 'PRACTICE'] } } });
  check('G: skill evidence was recorded for both attempts with the full trail', evid.length >= 2 && evid.every((e) => e.assessmentId && e.assessmentType && e.attemptNumber && e.weight), `${evid.length} rows`);
  const graph = await prisma.employeeSkill.findMany({ where: { profileId: agent.id, evidenceCount: { gt: 0 } }, include: { skill: true } });
  check('G: Skill Graph scores were recomputed from the evidence', graph.length > 0 && graph.every((s) => s.currentScore >= 0 && s.currentScore <= 100 && s.lastAssessedAt), graph.map((s) => `${s.skill.name}=${s.currentScore}`).join(', '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) console.log('FAILED:\n - ' + failed.map((r) => r.name).join('\n - '));
  await prisma.$disconnect();
  process.exit(failed.length ? 2 : 0);
}
main().catch(async (err) => { console.error('Live run crashed:', err); await prisma.$disconnect().catch(() => undefined); process.exit(1); });
