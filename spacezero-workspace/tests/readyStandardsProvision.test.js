'use strict';
// On every deploy the app makes sure the ready-made Company Standards & Workflow documents exist - each
// added once per organization. It never replaces anything, never brings back what an Admin edited,
// archived or deleted, and acknowledges nobody.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('../lib/prisma');
const { READY, provisionOrganization } = require('../lib/readyStandards');
const { getSetting } = require('../lib/orgSettings');

let org, admin, general;
const items = (organizationId) => prisma.standardsItem.findMany({ where: { organizationId }, include: { versions: true, currentVersion: true } });

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Provision tests' } });
  admin = await prisma.profile.create({ data: { organizationId: org.id, fullName: 'Prov Admin', username: `pv_${org.id}`, email: `pv_${org.id}@example.invalid`, role: 'ADMIN', status: 'ACTIVE', employmentStartDate: new Date() } });
  general = READY.find((r) => r.key === 'general-company-standard').doc;
});
after(async () => { await prisma.$disconnect(); });

test('the first start adds every missing document, published, for the right audience, acknowledging nobody', async () => {
  // The General Standard already exists (as on production), edited and requiring acknowledgement.
  const existing = await prisma.standardsItem.create({ data: { organizationId: org.id, contentType: 'STANDARD', title: general.title, createdById: admin.id } });
  const v = await prisma.standardsVersion.create({ data: { itemId: existing.id, version: 1, status: 'PUBLISHED', createdById: admin.id, publishedAt: new Date(), acknowledgementRequired: true, contentJson: JSON.stringify([{ type: 'paragraph', text: 'My own wording.' }]) } });
  await prisma.standardsItem.update({ where: { id: existing.id }, data: { currentVersionId: v.id } });

  const result = await provisionOrganization(org.id);
  assert.equal(result.added, 8, 'the eight missing ones');
  const all = await items(org.id);
  assert.equal(all.length, 9);
  for (const { doc } of READY) assert.equal(all.filter((i) => i.title === doc.title).length, 1, doc.title);
  assert.ok(all.filter((i) => i.id !== existing.id).every((i) => i.currentVersion && i.currentVersion.status === 'PUBLISHED'));
  const sup = all.find((i) => i.title === 'Supervisor Responsibilities');
  assert.equal(sup.rolesJson, JSON.stringify(['SUPERVISOR']));
  const untouched = all.find((i) => i.id === existing.id);
  assert.equal(untouched.versions.length, 1, 'the existing document was not touched');
  assert.equal(untouched.currentVersion.contentJson, v.contentJson);
  assert.equal(untouched.currentVersion.acknowledgementRequired, true);
  assert.equal(await prisma.standardsAcknowledgement.count({ where: { item: { organizationId: org.id } } }), 0);
  assert.equal((await getSetting(org.id, 'standards.readyProvisioned')).length, 9, 'every key is remembered');
});

test('later deploys change nothing - an archived, edited or deleted document is not brought back', async () => {
  const all = await items(org.id);
  const archivedItem = all.find((i) => i.title === 'Management Responsibilities');
  await prisma.standardsItem.update({ where: { id: archivedItem.id }, data: { archivedAt: new Date() } });
  const deletedItem = all.find((i) => i.title === 'Flight Expert Responsibilities');
  await prisma.standardsItem.delete({ where: { id: deletedItem.id } });
  const edited = all.find((i) => i.title === 'Supervisor Responsibilities');
  await prisma.standardsResponsibilityItem.updateMany({ where: { versionId: edited.currentVersionId }, data: { text: '**1. Mine.** My edited text.' } });

  assert.equal((await provisionOrganization(org.id)).added, 0);
  const after = await items(org.id);
  assert.equal(after.length, 8, 'the deleted one stays deleted');
  assert.equal(after.filter((i) => i.title === 'Management Responsibilities').length, 1, 'no second copy of the archived one');
  assert.ok(after.find((i) => i.title === 'Management Responsibilities').archivedAt, 'still archived');
  assert.equal((await prisma.standardsResponsibilityItem.findFirst({ where: { versionId: edited.currentVersionId } })).text, '**1. Mine.** My edited text.');
  assert.equal(after.find((i) => i.id === edited.id).versions.length, 1, 'edited document has no new version');
});

test('an organization that has an archived copy before its first start is not given a duplicate', async () => {
  const other = await prisma.organization.create({ data: { name: 'Provision tests 2' } });
  const adm = await prisma.profile.create({ data: { organizationId: other.id, fullName: 'Prov Admin 2', username: `pv2_${other.id}`, email: `pv2_${other.id}@example.invalid`, role: 'ADMIN', status: 'ACTIVE', employmentStartDate: new Date() } });
  await prisma.standardsItem.create({ data: { organizationId: other.id, contentType: 'RESPONSIBILITY', title: 'Travel Agent Responsibilities', createdById: adm.id, archivedAt: new Date() } });
  assert.equal((await provisionOrganization(other.id)).added, 8);
  assert.equal(await prisma.standardsItem.count({ where: { organizationId: other.id, title: 'Travel Agent Responsibilities' } }), 1);
});

test('an organization with no active Admin yet is skipped and tried again at the next start', async () => {
  const empty = await prisma.organization.create({ data: { name: 'Provision tests 3' } });
  assert.deepEqual(await provisionOrganization(empty.id), { added: 0, skipped: true });
  assert.equal(await prisma.standardsItem.count({ where: { organizationId: empty.id } }), 0);
  assert.deepEqual(await getSetting(empty.id, 'standards.readyProvisioned'), []);
  await prisma.profile.create({ data: { organizationId: empty.id, fullName: 'Late Admin', username: `pv3_${empty.id}`, email: `pv3_${empty.id}@example.invalid`, role: 'ADMIN', status: 'ACTIVE', employmentStartDate: new Date() } });
  assert.equal((await provisionOrganization(empty.id)).added, 9);
});
