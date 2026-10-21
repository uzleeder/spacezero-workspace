'use strict';
// LOCAL DEMO ONLY. Fills Employees & Teams with realistic sample data so every tab has something to show:
// employees (agents, flight experts, supervisors), three teams with supervisors, skill scores with five
// months of history (Intelligence), a training assignment (some overdue) and vacation requests.
//
//   node --env-file=.env scripts/seed-management-demo.cjs           add (or refresh) the demo data
//   node --env-file=.env scripts/seed-management-demo.cjs --remove  delete every record this script made
//
// Refuses to run in production or against PostgreSQL. Demo people have usernames starting with "sample."
// and @example.com e-mails, no password (they cannot sign in) and no e-mail is ever sent. Demo teams carry
// the DEMO_MARK description. Nothing else in the organization is touched.
const { prisma } = require('../lib/prisma');

const PREFIX = 'sample.';
const DEMO_MARK = 'Sample team (demo data)';
const DAY = 86400000;

const TEAMS = [
  { name: 'Premium Sales', supervisor: 'Laura Bennett', members: [['Daniel Ortiz', 'TRAVEL_AGENT', 82], ['Sofia Marino', 'TRAVEL_AGENT', 91], ['Kevin Walsh', 'TRAVEL_AGENT', 64], ['Amira Haddad', 'TRAVEL_AGENT', 77], ['Lucas Fischer', 'TRAVEL_AGENT', 58, 'INVITED']] },
  { name: 'Corporate Travel', supervisor: 'Marcus Reid', members: [['Elena Petrova', 'TRAVEL_AGENT', 73], ['James Carter', 'TRAVEL_AGENT', 49], ['Nadia Rahman', 'TRAVEL_AGENT', 86], ['Tom Becker', 'TRAVEL_AGENT', 68, 'ACTIVE', 'noSupervisor']] },
  { name: 'Flight Desk', supervisor: 'Priya Nair', members: [['Omar Khalil', 'FLIGHT_EXPERT', 88], ['Hannah Schmidt', 'FLIGHT_EXPERT', 61], ['Victor Alves', 'FLIGHT_EXPERT', 79], ['Mei Tanaka', 'FLIGHT_EXPERT', 54]] },
];
const UNASSIGNED = [['Ryan Brooks', 'TRAVEL_AGENT', 70, 'ACTIVE'], ['Chloe Martin', 'TRAVEL_AGENT', 0, 'DISABLED']];

const slug = (name) => PREFIX + name.toLowerCase().replace(/[^a-z]+/g, '.');
const clamp = (n) => Math.max(5, Math.min(99, Math.round(n)));
// Deterministic "random" so re-running gives the same picture.
let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const utcDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

async function removeDemo(organizationId) {
  const people = await prisma.profile.findMany({ where: { organizationId, username: { startsWith: PREFIX } }, select: { id: true } });
  const ids = people.map((p) => p.id);
  await prisma.leaveRequest.deleteMany({ where: { profileId: { in: ids } } });
  await prisma.trainingAssignment.deleteMany({ where: { organizationId, notes: DEMO_MARK } });
  await prisma.supervisorAssignment.deleteMany({ where: { OR: [{ agentId: { in: ids } }, { supervisorId: { in: ids } }] } });
  await prisma.profile.deleteMany({ where: { id: { in: ids } } }); // cascades memberships and skills
  const teams = await prisma.team.deleteMany({ where: { organizationId, description: DEMO_MARK } });
  return { people: ids.length, teams: teams.count };
}

async function upsertPerson(organizationId, adminId, name, role, status, monthsAgo, extra = {}) {
  const username = slug(name);
  const data = { fullName: name, role, status, employmentStartDate: new Date(Date.now() - monthsAgo * 30 * DAY), archivedAt: null, ...extra };
  return prisma.profile.upsert({
    where: { username },
    update: data,
    create: { ...data, organizationId, username, email: `${username}@example.com`, createdById: adminId },
  });
}

async function main() {
  if (process.env.NODE_ENV === 'production' || /^postgres(?:ql)?:/.test(process.env.DATABASE_URL || '')) {
    throw new Error('Demo data is for local development only (NODE_ENV=production or a PostgreSQL DATABASE_URL was found).');
  }
  const organization = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!organization) throw new Error('No organization found. Run the seed first: node --env-file=.env prisma/seed.js');
  const organizationId = organization.id;

  // Always start clean, so a re-run refreshes instead of piling up duplicates.
  const removed = await removeDemo(organizationId);
  if (process.argv.includes('--remove')) { console.log(`Removed ${removed.people} demo people and ${removed.teams} demo teams.`); return; }

  const admin = await prisma.profile.findFirst({ where: { organizationId, role: 'ADMIN', status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  if (!admin) throw new Error('No active Admin found. Create one first (scripts/create-demo-account.cjs).');
  const skills = await prisma.skill.findMany({ where: { organizationId, isActive: true } });
  const now = new Date();
  const agents = []; // { profile, role, level, teamId, supervisorId }

  for (const t of TEAMS) {
    const team = await prisma.team.create({ data: { organizationId, name: t.name, description: DEMO_MARK, createdById: admin.id } });
    const sup = await upsertPerson(organizationId, admin.id, t.supervisor, 'SUPERVISOR', 'ACTIVE', 30, { localPhone: '+1 555 0100' });
    await prisma.teamMembership.create({ data: { teamId: team.id, profileId: sup.id } });
    for (const [i, [name, role, level, status = 'ACTIVE', flag]] of t.members.entries()) {
      const p = await upsertPerson(organizationId, admin.id, name, role, status, 3 + i * 5, i % 2 === 0 ? { localPhone: `+1 555 01${10 + i}` } : {});
      await prisma.teamMembership.create({ data: { teamId: team.id, profileId: p.id } });
      if (flag !== 'noSupervisor') await prisma.supervisorAssignment.create({ data: { supervisorId: sup.id, agentId: p.id, teamId: team.id, assignedById: admin.id } });
      agents.push({ profile: p, role, level, status, teamId: team.id, supervisorId: flag === 'noSupervisor' ? null : sup.id });
    }
  }
  for (const [name, role, level, status] of UNASSIGNED) {
    const p = await upsertPerson(organizationId, admin.id, name, role, status, 8);
    agents.push({ profile: p, role, level, status, teamId: null, supervisorId: null });
  }

  // ---- skills: a current score around each person's level, plus monthly history that mostly improves
  let skillRows = 0;
  for (const a of agents.filter((x) => x.status === 'ACTIVE' && x.level > 0)) {
    for (const skill of skills.filter((s) => s.roleKey === a.role)) {
      const current = clamp(a.level + (rand() - 0.5) * 30);
      const evidenceCount = 2 + Math.floor(rand() * 6);
      const last = new Date(now.getTime() - Math.floor(rand() * 20) * DAY);
      const es = await prisma.employeeSkill.create({
        data: { profileId: a.profile.id, skillId: skill.id, currentScore: current, confidence: 0.4 + rand() * 0.5, confidenceLevel: evidenceCount > 4 ? 'HIGH' : 'MEDIUM', evidenceCount, lastEvidenceAt: last, lastAssessedAt: last, recommendedPractice: current < 70 },
      });
      const history = [];
      for (let m = 4; m >= 0; m -= 1) {
        history.push({ employeeSkillId: es.id, score: clamp(current - m * (2 + rand() * 4)), confidence: 0.5, evidenceCount, confidenceLevel: 'MEDIUM', recordedAt: new Date(now.getTime() - (m * 30 + 3) * DAY), note: 'Demo history' });
      }
      await prisma.skillScoreHistory.createMany({ data: history });
      skillRows += 1;
    }
  }

  // ---- training: one assignment of a published course; half the recipients are already overdue
  const course = await prisma.trainingCourse.findFirst({ where: { organizationId, status: 'PUBLISHED', archivedAt: null } });
  let assigned = 0;
  if (course) {
    const active = agents.filter((x) => x.status === 'ACTIVE');
    const overdue = await prisma.trainingAssignment.create({ data: { organizationId, courseId: course.id, courseVersion: course.publishedVersion || 1, assignedById: admin.id, scope: 'INDIVIDUAL', dueDate: new Date(now.getTime() - 5 * DAY), notes: DEMO_MARK } });
    const upcoming = await prisma.trainingAssignment.create({ data: { organizationId, courseId: course.id, courseVersion: course.publishedVersion || 1, assignedById: admin.id, scope: 'INDIVIDUAL', dueDate: new Date(now.getTime() + 14 * DAY), notes: DEMO_MARK } });
    for (const [i, a] of active.entries()) {
      await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: (i % 2 ? overdue : upcoming).id, profileId: a.profile.id } });
      assigned += 1;
    }
  }

  // ---- vacations: this month and the next two, every status, a few supervisor recommendations
  const today = utcDay(now);
  const plan = [
    [0, -12, 4, 'VACATION', 'APPROVED', 'RECOMMEND_APPROVE'], [1, -3, 5, 'VACATION', 'APPROVED', 'NONE'], [2, 2, 3, 'SICK', 'APPROVED', 'NONE'],
    [3, 5, 6, 'VACATION', 'PENDING', 'RECOMMEND_APPROVE'], [4, 9, 2, 'PERSONAL', 'PENDING', 'NONE'], [5, 12, 9, 'VACATION', 'PENDING', 'RECOMMEND_REJECT'],
    [6, 16, 4, 'VACATION', 'REJECTED', 'RECOMMEND_REJECT'], [7, 20, 5, 'VACATION', 'APPROVED', 'RECOMMEND_APPROVE'], [8, 24, 1, 'PERSONAL', 'CANCELLED', 'NONE'],
    [9, 30, 7, 'VACATION', 'PENDING', 'NONE'], [10, 38, 10, 'UNPAID', 'APPROVED', 'NONE'], [11, 45, 5, 'VACATION', 'PENDING', 'RECOMMEND_APPROVE'],
    [12, 3, 4, 'VACATION', 'APPROVED', 'NONE'], [0, 52, 6, 'VACATION', 'PENDING', 'NONE'],
  ];
  const people = agents.filter((x) => x.status === 'ACTIVE');
  for (const [who, offset, days, leaveType, status, recommendation] of plan) {
    const a = people[who % people.length];
    const startDate = new Date(today.getTime() + offset * DAY);
    const decided = status === 'APPROVED' || status === 'REJECTED';
    await prisma.leaveRequest.create({
      data: {
        organizationId, profileId: a.profile.id, teamId: a.teamId, supervisorId: a.supervisorId, leaveType, status, recommendation,
        startDate, endDate: new Date(startDate.getTime() + (days - 1) * DAY), days, note: leaveType === 'SICK' ? 'Doctor’s note attached.' : 'Family trip.',
        supervisorReviewedById: recommendation !== 'NONE' ? a.supervisorId : null, supervisorReviewedAt: recommendation !== 'NONE' ? now : null,
        reviewedById: decided ? admin.id : null, reviewedAt: decided ? now : null,
      },
    });
  }

  console.log(`Demo data ready in ${organization.name}: ${agents.length + TEAMS.length} people, ${TEAMS.length} teams, ${skillRows} skill scores, ${assigned} training assignments, ${plan.length} leave requests.`);
  console.log('Remove it any time: node --env-file=.env scripts/seed-management-demo.cjs --remove');
}

main()
  .catch((err) => { console.error(`Demo data was not created: ${err.message}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
