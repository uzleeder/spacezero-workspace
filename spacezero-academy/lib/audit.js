'use strict';

const { prisma } = require('./prisma');

async function logAudit(params) {
  // When an Admin is "viewing as" an employee the actor is that employee (their session), so the Admin behind the
  // request is written into the entry too - the log never makes the Admin's actions look like the employee's own.
  const viaAdminId = require('./requestContext').impersonatorId();
  const metadata = viaAdminId && viaAdminId !== params.actorId ? { ...(params.metadata || {}), viaAdminId } : params.metadata;
  await prisma.auditLog.create({
    data: {
      organizationId: params.organizationId,
      actorId: params.actorId,
      action: params.action,
      targetTable: params.targetTable,
      targetId: params.targetId,
      metadataJson: metadata ? JSON.stringify(metadata) : undefined,
    },
  });
}

module.exports = { logAudit };
