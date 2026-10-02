'use strict';
// While editing a Workflow, each step's explanation and checklist (e.g. "Current examples may include:"
// + OAG / Cockpit / AGF) must be visible - not hidden behind a collapsed box - and long Responsibility
// entries must be editable in a proper multi-line box. Saving round-trips everything unchanged.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const { applyReady } = require('../lib/readyStandards');
const app = require('../server');

let org, admin, cookie;
before(async () => {
  org = await prisma.organization.create({ data: { name: 'Editor visibility tests' } });
  admin = await prisma.profile.create({ data: { organizationId: org.id, fullName: 'Editor Admin', username: `ev_${org.id}`, email: `ev_${org.id}@example.invalid`, role: 'ADMIN', status: 'ACTIVE', employmentStartDate: new Date() } });
  const token = generateToken();
  await prisma.session.create({ data: { profileId: admin.id, tokenHash: token.hash, expiresAt: new Date(Date.now() + 3600000) } });
  cookie = `sz_session=${token.raw}`;
  await applyReady(admin);
});
after(async () => { await prisma.$disconnect(); });

test('a step\'s explanation and checklist are open and labelled in the editor', async () => {
  const flow = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Travel Agent — Client Handling, CRM & Sales Workflow' } });
  const page = await request(app).get(`/admin/standards/${flow.id}/edit`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  const step = page.text.split('value="Basic Agent search"')[1].split('data-repeater-item')[0];
  assert.match(step, /<details class="mt-8" open>/, 'the details box is open for a step that has details');
  assert.match(step, /Explanation, checklist &amp; notes/);
  assert.match(step, />Current examples may include:<\/textarea>/);
  assert.match(step, />OAG\nCockpit\nAGF\nOther approved tools<\/textarea>/);
  assert.match(page.text, /Step title/);
  assert.match(page.text, /<label class="text-sm text-muted">Instruction<\/label>/);
  // A step without any details stays tidy (collapsed) until someone opens it.
  const plain = page.text.split('value="First contact"')[1].split('data-repeater-item')[0];
  assert.match(plain, /<details class="mt-8" >/);
});

test('Responsibility entries are edited in a multi-line box', async () => {
  const resp = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Travel Agent Responsibilities' } });
  const page = await request(app).get(`/admin/standards/${resp.id}/edit`).set('Cookie', cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<textarea name="respText" rows="\d" maxlength="500"[^>]*>\*\*1\. Industry &amp; product knowledge\.\*\*/);
  assert.doesNotMatch(page.text, /<input name="respText"/);
});

test('opening the editor and pressing Save without changing anything keeps every explanation, checklist and note (as the browser would post it)', async () => {
  const flow = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Management — Team Oversight & Operational Support Workflow' } });
  const before = await prisma.standardsVersion.findUnique({ where: { id: flow.currentVersionId }, include: { steps: { orderBy: { displayOrder: 'asc' } } } });
  const page = await request(app).get(`/admin/standards/${flow.id}/edit`).set('Cookie', cookie);
  const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const region = page.text.slice(page.text.indexOf('data-repeater="steps"'), page.text.indexOf('<template data-repeater-template>', page.text.indexOf('data-repeater="steps"')));
  const field = (name) => [...region.matchAll(new RegExp(`<textarea name="${name}"[^>]*>([\\s\\S]*?)</textarea>|<input name="${name}" value="([^"]*)"`, 'g'))].map((m) => decode(m[1] !== undefined ? m[1] : m[2]));
  const body = { title: flow.title, category: flow.category, rolesAudience: 'ROLES', roles: ['ADMIN'], shortDescription: before.shortDescription, action: 'publish',
    stepTitle: field('stepTitle'), stepInstruction: field('stepInstruction'), stepExplanation: field('stepExplanation'), stepChecklist: field('stepChecklist'),
    stepImportantNote: field('stepImportantNote'), stepWarning: field('stepWarning'), stepDisclosureRefId: before.steps.map(() => ''), stepRelatedItemId: before.steps.map(() => '') };
  assert.equal(body.stepTitle.length, before.steps.length, 'every step is in the form');
  assert.ok(body.stepChecklist.some((c) => c.includes('\n')), 'checklists are filled in the form');
  assert.equal((await request(app).post(`/admin/standards/${flow.id}`).set('Cookie', cookie).type('form').send(body)).status, 302);
  const after = await prisma.standardsItem.findUnique({ where: { id: flow.id }, include: { currentVersion: { include: { steps: { orderBy: { displayOrder: 'asc' } } } } } });
  assert.equal(after.currentVersion.steps.length, before.steps.length);
  after.currentVersion.steps.forEach((s, i) => {
    assert.equal(s.title, before.steps[i].title);
    assert.equal(s.instruction, before.steps[i].instruction);
    assert.deepEqual(JSON.parse(s.detailJson || 'null'), JSON.parse(before.steps[i].detailJson || 'null'), `step ${i + 1} details unchanged`);
  });
});

test('saving the editor unchanged keeps every step detail (nothing is lost by the new layout)', async () => {
  const flow = await prisma.standardsItem.findFirst({ where: { organizationId: org.id, title: 'Travel Agent — Client Handling, CRM & Sales Workflow' }, include: { currentVersion: { include: { steps: { orderBy: { displayOrder: 'asc' } } } } } });
  const steps = flow.currentVersion.steps.map((s) => ({ title: s.title, instruction: s.instruction, ...JSON.parse(s.detailJson || '{}') }));
  const body = {
    title: flow.title, category: flow.category, rolesAudience: 'ROLES', roles: ['TRAVEL_AGENT'], shortDescription: flow.currentVersion.shortDescription, action: 'publish',
    stepTitle: steps.map((s) => s.title), stepInstruction: steps.map((s) => s.instruction), stepExplanation: steps.map((s) => s.explanation || ''),
    stepChecklist: steps.map((s) => (s.checklist || []).join('\n')), stepImportantNote: steps.map((s) => s.importantNote || ''), stepWarning: steps.map((s) => s.warning || ''),
    stepDisclosureRefId: steps.map(() => ''), stepRelatedItemId: steps.map(() => ''),
  };
  assert.equal((await request(app).post(`/admin/standards/${flow.id}`).set('Cookie', cookie).type('form').send(body)).status, 302);
  const after = await prisma.standardsItem.findUnique({ where: { id: flow.id }, include: { currentVersion: { include: { steps: { orderBy: { displayOrder: 'asc' } } } } } });
  const eight = after.currentVersion.steps.find((s) => s.title === 'Basic Agent search');
  assert.deepEqual(JSON.parse(eight.detailJson), { explanation: 'Current examples may include:', checklist: ['OAG', 'Cockpit', 'AGF', 'Other approved tools'] });
});
