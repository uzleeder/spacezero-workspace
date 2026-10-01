'use strict';

const { prisma } = require('./prisma');
const { ensureEmployeeSkills, getSkillGraph } = require('./skills');
const { getMyTrainingList, getMyTrainingSummary } = require('./training');
const { resolveTenureBand, monthsSince } = require('./tenure');
const { loadSetupForProfile } = require('./employeeSetup');
const { ackSummaryForProfile } = require('./standards');
const { readinessFor } = require('./readiness');

// Assembles everything the shared profile-overview partial needs. Reused by
// /profile (self), /admin/employees/:id (admin), and /team/:id (supervisor)
// so the three "view an employee" surfaces stay in sync.
async function loadProfileOverview(profileId) {
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
    include: {
      teamMemberships: { include: { team: true } },
      supervisedBy: { where: { unassignedAt: null }, include: { supervisor: true } },
    },
  });
  if (!profile) return null;

  const [summary, trainingList, tenureBands, certificates, setup, upcomingLeave, standardsAck, callReviews] = await Promise.all([
    getMyTrainingSummary(profileId),
    getMyTrainingList(profileId),
    prisma.tenureBand.findMany({ where: { organizationId: profile.organizationId } }),
    prisma.certificate.findMany({ where: { profileId }, orderBy: { issuedAt: 'desc' } }),
    loadSetupForProfile(profile.organizationId, profile),
    prisma.leaveRequest.findMany({ where: { profileId, status: { in: ['PENDING', 'APPROVED'] }, endDate: { gte: new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z') } }, orderBy: { startDate: 'asc' }, take: 3 }),
    ackSummaryForProfile(profile.organizationId, profile),
    // Call Reviews kept as its own feature/route (not duplicated here) — this is just the
    // employee-specific slice surfaced on the profile now that the top-level tab is gone.
    prisma.callReview.findMany({ where: { agentId: profileId }, include: { supervisor: true }, orderBy: { createdAt: 'desc' }, take: 10 }),
  ]);

  const hasSkillGraph = profile.role === 'TRAVEL_AGENT' || profile.role === 'FLIGHT_EXPERT';
  if (hasSkillGraph) await ensureEmployeeSkills(profileId, profile.organizationId, profile.role);
  const skills = hasSkillGraph ? await getSkillGraph(profileId) : [];
  const tenureBand = resolveTenureBand(profile.employmentStartDate, tenureBands);
  // Same decision function every dashboard already uses — a compact "Status" line here can never
  // disagree with the readiness badge shown elsewhere for the same person.
  const readiness = (await readinessFor(profile.organizationId, [profile], { setupMap: new Map([[profile.id, setup]]) })).get(profile.id) || null;

  return {
    profile,
    summary,
    trainingList,
    skills,
    hasSkillGraph,
    tenureBand,
    tenureMonths: monthsSince(profile.employmentStartDate),
    certificates,
    setup,
    upcomingLeave,
    standardsAck,
    callReviews,
    readiness,
    // The address itself is only ever shown on the Setup tab; the overview says whether one is on file.
    hasAddress: Boolean(profile.currentAddressEnc),
  };
}

module.exports = { loadProfileOverview };
