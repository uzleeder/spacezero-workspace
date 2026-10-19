'use strict';
// Optional external scheduler entry point for hosts without a continuously running Node server.
// Run once a minute with the same database/email environment as the app.
require('../lib/trainingEmails').drain()
  .catch(() => { console.error('Training email worker failed'); process.exitCode = 1; })
  .finally(() => require('../lib/prisma').prisma.$disconnect());
