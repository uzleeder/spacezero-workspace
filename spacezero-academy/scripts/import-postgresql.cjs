'use strict';
// Run only against a NEW PostgreSQL database after applying its migrations.
// No deletions or overwrites; the entire import is one transaction.
const { PrismaClient: SQLite, Prisma } = require('@prisma/client');
const { PrismaClient: PostgreSQL } = require('../generated/postgresql');
if (!process.env.SQLITE_DATABASE_URL?.startsWith('file:') || !/^postgres(?:ql)?:/.test(process.env.POSTGRES_DATABASE_URL || '')) throw Error('Set SQLITE_DATABASE_URL and POSTGRES_DATABASE_URL');
const source = new SQLite({ datasourceUrl: process.env.SQLITE_DATABASE_URL });
const destination = new PostgreSQL({ datasourceUrl: process.env.POSTGRES_DATABASE_URL });
const models = require('./import-models.cjs').importModels(Prisma.dmmf.datamodel.models);
async function main() {
  const snapshot = await source.$transaction(async tx => {
    const result = {};
    for (const model of models) result[model] = await tx[model].findMany();
    return result;
  });
  await destination.$transaction(async tx => {
    for (const metadata of Prisma.dmmf.datamodel.models) {
      const model = metadata.name[0].toLowerCase() + metadata.name.slice(1);
      if (await tx[model].count()) throw Error('Destination must be empty');
    }
    for (const model of models) {
      const rows = snapshot[model].map(row => {
        if (model === 'profile') return { ...row, createdById:null, testOwnerAdminId:null };
        if (model === 'libraryCategory') return { ...row, parentId:null };
        if (model === 'practiceSession') return { ...row, busy:false };
        return row;
      });
      if (rows.length) await tx[model].createMany({ data:rows });
    }
    for (const row of snapshot.profile) await tx.profile.update({ where:{id:row.id}, data:{createdById:row.createdById,testOwnerAdminId:row.testOwnerAdminId} });
    for (const row of snapshot.libraryCategory) if(row.parentId) await tx.libraryCategory.update({where:{id:row.id},data:{parentId:row.parentId}});
    for (const model of models) if(await tx[model].count() !== snapshot[model].length) throw Error(`Count verification failed: ${model}`);
  }, { timeout:120000 });
  console.log('Import committed. All model counts verified. Sessions and activation/reset tokens were intentionally not transferred; resend pending invitations. Copy private storage separately.');
}
main().catch(()=>{console.error('Import failed; destination transaction rolled back. Check connectivity and data constraints.');process.exitCode=1;}).finally(async()=>{await source.$disconnect();await destination.$disconnect();});
