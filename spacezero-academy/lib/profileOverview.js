'use strict';

const { prisma } = require('./prisma');
const { ensureEmployeeSkills, getSkillGraph } = require('./skills');
const { getMyTrainingList, getMyTrainingSummary } = require('./training');
const { resolveTenureBand, monthsSince } = require('./tenure');
const { loadSetupForProfile } = require('./employeeSetup');

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

  const [summary, trainingList, tenureBands, certificates, setup, upcomingLeave] = await Promise.all([
    getMyTrainingSummary(profileId),
    getMyTrainingList(profileId),
    prisma.tenureBand.findMany({ where: { organizationId: profile.organizationId } }),
    prisma.certificate.findMany({ where: { profileId }, orderBy: { issuedAt: 'desc' } }),
    loadSetupForProfile(profile.organizationId, profile),
    prisma.leaveRequest.findMany({ where: { profileId, status: { in: ['PENDING', 'APPROVED'] }, endDate: { gte: new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z') } }, orderBy: { startDate: 'asc' }, take: 3 }),
  ]);

  const hasSkillGraph = profile.role === 'TRAVEL_AGENT' || profile.role === 'FLIGHT_EXPERT';
  if (hasSkillGraph) await ensureEmployeeSkills(profileId, profile.organizationId, profile.role);
  const skills = hasSkillGraph ? await getSkillGraph(profileId) : [];
  const tenureBand = resolveTenureBand(profile.employmentStartDate, tenureBands);

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
    // The address itself is only ever shown on the Setup tab; the overview says whether one is on file.
    hasAddress: Boolean(profile.currentAddressEnc),
  };
}

module.exports = { loadProfileOverview };
