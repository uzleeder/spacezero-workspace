'use strict';

const { prisma } = require('./prisma');

function latestAttempt(attempts) {
  if (!attempts || attempts.length === 0) return undefined;
  return [...attempts].sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
}

async function getMyTrainingList(profileId) {
  const recipients = await prisma.trainingAssignmentRecipient.findMany({
    where: { profileId },
    include: { assignment: { include: { course: { include: { modules: true } } } }, attempts: true },
    orderBy: { createdAt: 'desc' },
  });

  return recipients.map((r) => ({
    ...r,
    status: (latestAttempt(r.attempts) || {}).status || 'NOT_STARTED',
    latestAttempt: latestAttempt(r.attempts) || null,
  }));
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

module.exports = { getMyTrainingList, getMyTrainingSummary };
