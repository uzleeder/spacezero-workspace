'use strict';

const { prisma } = require('./prisma');

async function logAudit(params) {
  await prisma.auditLog.create({
    data: {
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: params.action,
      targetTable: params.targetTable,
      targetId: params.targetId,
      metadataJson: params.metadata ? JSON.stringify(params.metadata) : undefined,
    },
  });
}

module.exports = { logAudit };
