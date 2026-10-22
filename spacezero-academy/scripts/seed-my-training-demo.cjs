'use strict';
// LOCAL DEMO ONLY. Gives the demo accounts (scripts/create-demo-account.cjs) training to go through on My Training, in
// every state the path shows: completed, in progress, a failed practice (retake), overdue, due soon, due later and no
// due date - enough of it (14 for the Travel Agent) that both folds of the path are in use.
//
//   node --env-file=.env scripts/seed-my-training-demo.cjs           add (or refresh) the demo training
//   node --env-file=.env scripts/seed-my-training-demo.cjs --remove  delete every training this script made
//
// Options for trying things out:
//   --video=/path/to/clip.mp4   also gives demo-agent a FINISHED training with that (short, H.264) video, to try review mode
//   --retake-wait=2             sets the wait after a failed try (training.retakeWaitMinutes) to 2 minutes; the default is 10
//
// Refuses to run in production or against PostgreSQL. Demo trainings carry DEMO_MARK as their purpose and are only
// assigned to the demo accounts; no e-mail is sent. Every training has short notes and a real two-question quiz,
// so it can be opened, read and passed (or failed) like any other. Nothing else in the organization is touched.
const { prisma } = require('../lib/prisma');
const fs = require('fs');
const { deleteCourse } = require('../lib/courseDeletion');
const { resolveStoragePath } = require('../lib/storage');
const { setSetting } = require('../lib/orgSettings');
const option = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || null;

/** The length of an MP4 in seconds, from its movie header (no ffprobe needed). */
function mp4Seconds(file) {
  const b = fs.readFileSync(file); const i = b.indexOf(Buffer.from('mvhd'));
  if (i < 0) throw new Error('Not an MP4 file: ' + file);
  const v1 = b[i + 4] === 1;
  return (v1 ? Number(b.readBigUInt64BE(i + 28)) : b.readUInt32BE(i + 20)) / b.readUInt32BE(i + (v1 ? 24 : 16));
}

const DEMO_MARK = 'MY_TRAINING_DEMO';
const DAY = 86400000;
const ago = (days) => new Date(Date.now() - days * DAY);
const inDays = (days) => new Date(Date.now() + days * DAY);

// title, category, what the learner has done: { completed: daysAgo, score } | 'started' | 'retake' | null, due in days
const PLANS = {
  'demo-agent': [
    ['Welcome to Above9: How We Work', 'SYSTEM_WORKFLOW', { completed: 40, score: 96 }, null],
    ['Qatar Qsuite Essentials', 'PRODUCT', { completed: 18, score: 88 }, null],
    ['CRM Lead Statuses', 'SYSTEM_WORKFLOW', { completed: 6, score: 92 }, null],
    ['Lufthansa First Class: Product & Lounges', 'PRODUCT', 'started', 5],
    ['Handling Price Objections', 'SALES', null, -4],
    ['Discovery Questions for Premium Travellers', 'SALES', null, -1],
    ['Emirates A380 Cabins', 'PRODUCT', null, 1],
    ['Amadeus GDS: Booking Business Class', 'SYSTEM_WORKFLOW', null, 3],
    ['Singapore Airlines Suites', 'PRODUCT', null, 9],
    ['Upselling to First Class', 'SALES', null, 16],
    ['Fare Rules & Changes', 'SYSTEM_WORKFLOW', null, 24],
    ['Corporate Travel Policies', 'SALES', null, null],
    ['Lounge Access Rules', 'PRODUCT', null, null],
    ['Handling Complaints Calmly', 'SALES', null, null],
  ],
  'demo-expert': [
    ['Welcome to Above9: How We Work', 'SYSTEM_WORKFLOW', { completed: 30, score: 100 }, null],
    ['Routing Through Doha', 'SYSTEM_WORKFLOW', 'retake', 2],
    ['Mixed-Cabin Itineraries', 'PRODUCT', null, -2],
    ['Fare Construction Basics', 'SYSTEM_WORKFLOW', null, 7],
    ['Married Segments & Availability', 'SYSTEM_WORKFLOW', null, 14],
    ['Award Space Searching', 'PRODUCT', null, null],
  ],
  'demo-supervisor': [
    ['Coaching from Call Reviews', 'SALES', null, 6],
    ['Running Team Huddles', 'SALES', null, 13],
    ['Reading Team Intelligence', 'SYSTEM_WORKFLOW', null, null],
  ],
  demo: [
    ['Welcome to Above9: How We Work', 'SYSTEM_WORKFLOW', { completed: 3, score: 100 }, null],
    ['Approving AI Practice', 'SYSTEM_WORKFLOW', null, 10],
    ['Company Standards: Keeping Them Current', 'SYSTEM_WORKFLOW', null, null],
  ],
};

const NOTES = [
  ['What this training covers', 'Read this first. It explains what you will learn and why it matters for premium travellers.'],
  ['Key points', 'The essentials, step by step. Take your time - the quiz asks about these points.'],
  ['In practice', 'How this looks on a real call or booking, with an example you can follow.'],
];

async function removeDemo(organizationId, admin) {
  const courses = await prisma.trainingCourse.findMany({ where: { organizationId, purpose: DEMO_MARK } });
  for (const course of courses) await deleteCourse(admin, course);
  return courses.length;
}

async function makeCourse(organizationId, admin, title, category) {
  return prisma.trainingCourse.create({
    data: {
      organizationId, title, trainingCategory: category, purpose: DEMO_MARK, description: `${title} - sample training for trying My Training.`,
      createdById: admin.id, status: 'PUBLISHED', publishedVersion: 1, draftVersion: 1, sentAt: ago(60), sentById: admin.id, assignPolicy: 'ALL_SUPERVISORS',
      modules: { create: NOTES.map(([t, text], i) => ({ title: t, contentType: 'NOTE', description: text, required: true, displayOrder: i })) },
      assessments: { create: [{ organizationId, createdVia: 'ADMIN_MANUAL', type: 'QUIZ', status: 'APPROVED', title: `${title}: quick check`, level: 2, passingScore: 70, createdById: admin.id, version: 1,
        questions: { create: [
          { type: 'MCQ', prompt: `What is the first thing to do in "${title}"?`, optionsJson: JSON.stringify(['Listen and confirm what the traveller needs', 'Quote the cheapest fare straight away']), correctAnswerJson: JSON.stringify('Listen and confirm what the traveller needs'), displayOrder: 0 },
          { type: 'TRUE_FALSE', prompt: 'Premium travellers value a calm, well-prepared answer over a fast guess.', correctAnswerJson: JSON.stringify('True'), displayOrder: 1 },
        ] } }] },
    },
    include: { modules: true, assessments: true },
  });
}

async function assign(organizationId, admin, course, person, state, dueDays) {
  const assignment = await prisma.trainingAssignment.create({ data: { organizationId, courseId: course.id, courseVersion: 1, assignedById: admin.id, scope: 'INDIVIDUAL', dueDate: dueDays === null ? null : inDays(dueDays), notes: DEMO_MARK, createdAt: ago(45) } });
  const r = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: assignment.id, profileId: person.id } });
  const quiz = course.assessments[0];
  const done = state && typeof state === 'object';
  const startedAt = done ? ago(state.completed + 3) : state ? ago(4) : null;
  const course_ = await prisma.trainingAttempt.create({ data: { recipientId: r.id, profileId: person.id, attemptNumber: 1, status: state ? 'IN_PROGRESS' : 'NOT_STARTED', startedAt } });
  const read = done || state === 'retake' ? course.modules : state === 'started' ? course.modules.slice(0, 2) : [];
  for (const m of read) await prisma.mediaProgress.upsert({ where: { profileId_trainingModuleId: { profileId: person.id, trainingModuleId: m.id } }, create: { profileId: person.id, trainingModuleId: m.id, startedAt, completedAt: startedAt, percentComplete: 100 }, update: { completedAt: startedAt, percentComplete: 100 } });
  if (state === 'retake') await prisma.trainingAttempt.create({ data: { recipientId: r.id, profileId: person.id, assessmentId: quiz.id, attemptNumber: 1, status: 'FAILED', score: 50, startedAt: ago(1), completedAt: ago(1) } });
  if (done) {
    await prisma.trainingAttempt.create({ data: { recipientId: r.id, profileId: person.id, assessmentId: quiz.id, attemptNumber: 1, status: 'COMPLETED', score: state.score, startedAt: ago(state.completed), completedAt: ago(state.completed) } });
    await prisma.trainingAttempt.update({ where: { id: course_.id }, data: { status: 'COMPLETED', score: state.score, completedAt: ago(state.completed), attemptNumber: 2 } });
  }
}

async function main() {
  if (process.env.NODE_ENV === 'production' || /^postgres(?:ql)?:/.test(process.env.DATABASE_URL || '')) {
    throw new Error('Demo data is for local development only (NODE_ENV=production or a PostgreSQL DATABASE_URL was found).');
  }
  const admin = await prisma.profile.findUnique({ where: { username: 'demo' } });
  if (!admin) throw new Error('No demo accounts yet. Create them first: node --env-file=.env scripts/create-demo-account.cjs');
  const organizationId = admin.organizationId;
  const removed = await removeDemo(organizationId, admin);
  if (process.argv.includes('--remove')) { console.log(`Removed ${removed} demo trainings (and their assignments, attempts and progress).`); return; }

  const courses = new Map(); // the same title is one training, assigned to several demo accounts
  let assigned = 0;
  for (const [username, plan] of Object.entries(PLANS)) {
    const person = await prisma.profile.findUnique({ where: { username } });
    if (!person) { console.log(`Skipped ${username}: not found.`); continue; }
    for (const [title, category, state, dueDays] of plan) {
      if (!courses.has(title)) courses.set(title, await makeCourse(organizationId, admin, title, category));
      await assign(organizationId, admin, courses.get(title), person, state, dueDays);
      assigned += 1;
    }
  }
  console.log(`My Training demo data: ${courses.size} trainings, ${assigned} assignments for ${Object.keys(PLANS).join(', ')}.`);

  // Review mode: a finished training whose required video was watched to the end
  const video = option('video');
  if (video) {
    const agent = await prisma.profile.findUnique({ where: { username: 'demo-agent' } });
    const seconds = mp4Seconds(video);
    const storagePath = 'training/demo-review-video.mp4';
    fs.mkdirSync(require('path').dirname(resolveStoragePath(storagePath)), { recursive: true });
    fs.copyFileSync(video, resolveStoragePath(storagePath));
    const course = await makeCourse(organizationId, admin, 'Product Video: Cabin Walkthrough', 'PRODUCT');
    await prisma.trainingModule.create({ data: { courseId: course.id, title: 'Cabin walkthrough (video)', contentType: 'VIDEO', storagePath, required: true, displayOrder: -1, sourceRefJson: JSON.stringify({ durationSeconds: seconds }) } });
    const withVideo = await prisma.trainingCourse.findUnique({ where: { id: course.id }, include: { modules: true, assessments: true } });
    await assign(organizationId, admin, withVideo, agent, { completed: 2, score: 100 }, null);
    const mod = withVideo.modules.find((m) => m.contentType === 'VIDEO');
    await prisma.mediaProgress.update({ where: { profileId_trainingModuleId: { profileId: agent.id, trainingModuleId: mod.id } }, data: { durationSeconds: Math.ceil(seconds), watchedRangesJson: JSON.stringify([[0, seconds]]), lastPositionSeconds: seconds } });
    console.log(`Review-mode video added to demo-agent: "${course.title}" (${seconds.toFixed(1)} s, finished).`);
  }
  const wait = option('retake-wait');
  if (wait !== null) {
    await setSetting(organizationId, 'training.retakeWaitMinutes', Number(wait), admin.id);
    console.log(`Wait after a failed try: ${Number(wait)} minute(s). Set it back with --retake-wait=10.`);
  }
  console.log('Remove it any time: node --env-file=.env scripts/seed-my-training-demo.cjs --remove');
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
