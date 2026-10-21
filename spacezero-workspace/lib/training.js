'use strict';

const { prisma } = require('./prisma');
const { trainingStatusFrom, assessmentsByCourse, courseAttempt, newestFirst } = require('./trainingCompletion');

function latestAttempt(attempts) {
  if (!attempts || attempts.length === 0) return undefined;
  // Highest attempt number wins; on a tie (practice attempts are numbered per practice) the newer one does.
  return [...attempts].sort(newestFirst)[0];
}

// The status itself follows the rules of submitting a training (trainingStatusFrom): a submitted training stays
// Completed, and Retake required means a required practice is still not passed.
async function getMyTrainingList(profileId) {
  const recipients = await prisma.trainingAssignmentRecipient.findMany({
    where: { profileId },
    include: { assignment: { include: { course: { include: { modules: true } } } }, attempts: true },
    orderBy: { createdAt: 'desc' },
  });
  const assessments = await assessmentsByCourse(recipients.map((r) => r.assignment.courseId));

  return recipients.map((r) => {
    const status = trainingStatusFrom(r, assessments.get(r.assignment.courseId) || []);
    // A finished training shows when it was submitted.
    return { ...r, status, latestAttempt: (status === 'COMPLETED' ? courseAttempt(r.attempts) : latestAttempt(r.attempts)) || null };
  });
}

async function getMyTrainingSummary(profileId) {
  const list = await getMyTrainingList(profileId);
  return {
    assigned: list.length,
    inProgress: list.filter((r) => r.status === 'IN_PROGRESS').length,
    completed: list.filter((r) => r.status === 'COMPLETED').length,
    retakeRequired: list.filter((r) => r.status === 'RETAKE_REQUIRED').length,
    notStarted: list.filter((r) => r.status === 'NOT_STARTED').length,
  };
}

const emptySummary = () => ({ assigned: 0, inProgress: 0, completed: 0, retakeRequired: 0, notStarted: 0 });

/**
 * getMyTrainingSummary for MANY people in one query (Map: profileId -> summary). Lists of employees
 * used to call getMyTrainingSummary once per row, which loaded every course, module and attempt of
 * every person — hundreds of queries for one page. Same numbers, two round trips per 500 people.
 */
async function getTrainingSummaries(profileIds) {
  const summaries = new Map(profileIds.map((id) => [id, emptySummary()]));
  for (let i = 0; i < profileIds.length; i += 500) {
    const recipients = await prisma.trainingAssignmentRecipient.findMany({
      where: { profileId: { in: profileIds.slice(i, i + 500) } },
      select: {
        profileId: true,
        assignment: { select: { courseId: true, courseVersion: true, assessmentId: true, requiredAttempts: true, minimumScore: true } },
        attempts: { select: { status: true, assessmentId: true, attemptNumber: true, createdAt: true, completedAt: true, score: true } },
      },
    });
    const assessments = await assessmentsByCourse(recipients.map((r) => r.assignment.courseId));
    for (const r of recipients) {
      const s = summaries.get(r.profileId);
      const status = trainingStatusFrom(r, assessments.get(r.assignment.courseId) || []);
      s.assigned += 1;
      if (status === 'IN_PROGRESS') s.inProgress += 1;
      else if (status === 'COMPLETED') s.completed += 1;
      else if (status === 'RETAKE_REQUIRED') s.retakeRequired += 1;
      else if (status === 'NOT_STARTED') s.notStarted += 1;
    }
  }
  return summaries;
}

module.exports = { getMyTrainingList, getMyTrainingSummary, getTrainingSummaries };
