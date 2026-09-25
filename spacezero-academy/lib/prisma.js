'use strict';

const { PrismaClient } = /^postgres(?:ql)?:/.test(process.env.DATABASE_URL || '')
  ? require('../generated/postgresql') : require('@prisma/client');

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

module.exports = { prisma };
