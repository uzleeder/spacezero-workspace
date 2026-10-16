'use strict';
// ONE shared Training Category (Product / Sales / System & Workflow) across the Training Catalog, Assignments,
// My Training and AI Practice -> Training; and My Training organised by STATUS then CATEGORY on one page.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const categories = require('../lib/trainingCategories');
const { buildMyTraining, groupOf, overdueText } = require('../lib/myTraining');
const versions = require('../lib/courseVersions');
const app = require('../server');

const DAY = 86400000;
let org, admin, sup, agent, cookies = {}, courses = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);
const names = (html, re = /data-training-card[\s\S]*?<a href="\/training-course\/[^"]+"[^>]*>([^<]+)</g) => [...html.matchAll(re)].map((m) => m[1]);

before(async () => {
  org = await prisma.organization.create({ data: { name: 'Training categories tests' } });
  const mk = async (role, name) => {
    const p = await prisma.profile.create({ data: { organizationId: org.id, fullName: name, username: `tc_${org.id}_${name}`, email: `tc_${org.id}_${name}@example.invalid`, role, status: 'ACTIVE', employmentStartDate: new Date() } });
    const t = generateToken(); await prisma.session.create({ data: { profileId: p.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[p.id] = `sz_session=${t.raw}`;
    return p;
  };
  admin = await mk('ADMIN', 'admin'); sup = await mk('SUPERVISOR', 'sup'); agent = await mk('TRAVEL_AGENT', 'agent');
  await prisma.supervisorAssignment.create({ data: { supervisorId: sup.id, agentId: agent.id, assignedById: admin.id } });
  const course = (title, trainingCategory, extra = {}) => prisma.trainingCourse.create({ data: { organizationId: org.id, title, createdById: admin.id, status: 'PUBLISHED', trainingCategory, assignPolicy: 'ALL_SUPERVISORS', ...extra } });
  courses.p1 = await course('Aircraft Cabins', 'PRODUCT'); courses.p2 = await course('Fare Families', 'PRODUCT');
  courses.s1 = await course('Handling Objections', 'SALES');
  courses.w1 = await course('CRM Statuses', 'SYSTEM_WORKFLOW');
  courses.old = await course('Legacy Course', null);
  courses.arch = await course('Old Product Course', 'PRODUCT', { status: 'ARCHIVED', archivedAt: new Date() });
});
after(async () => { await prisma.$disconnect(); });

test('the category module: three fixed categories, friendly labels, safe parsing', () => {
  assert.deepEqual(categories.KEYS, ['PRODUCT', 'SALES', 'SYSTEM_WORKFLOW']);
  assert.deepEqual(categories.CATEGORIES.map((c) => c.label), ['Product Training', 'Sales Training', 'System & Workflow Training']);
  assert.deepEqual(categories.CATEGORIES.map((c) => c.short), ['Product', 'Sales', 'System & Workflow']);
  assert.equal(categories.readCategory('SALES'), 'SALES');
  for (const bad of ['sales', 'AIRLINES', '', null, undefined, 5, {}]) assert.equal(categories.readCategory(bad), null);
  assert.equal(categories.categoryLabel(null), 'Uncategorized');
  assert.equal(categories.readFilter('UNCATEGORIZED'), 'UNCATEGORIZED'); assert.equal(categories.readFilter('x'), '');
  assert.equal(categories.suggestFromClassifications(JSON.stringify(['PRODUCT_KNOWLEDGE'])), 'PRODUCT');
  assert.equal(categories.suggestFromClassifications(JSON.stringify(['CUSTOMER_SERVICE'])), 'SALES');
  assert.equal(categories.suggestFromClassifications(JSON.stringify(['PROCESS_SOP', 'SALES_COMMUNICATION'])), 'SYSTEM_WORKFLOW');
  assert.equal(categories.suggestFromClassifications('not json'), '');
  assert.deepEqual(categories.countByCategory([{ trainingCategory: 'SALES' }, { trainingCategory: null }, { trainingCategory: 'PRODUCT' }, { trainingCategory: 'junk' }]), { UNCATEGORIZED: 2, PRODUCT: 1, SALES: 1, SYSTEM_WORKFLOW: 0 });
});

test('Training Catalog: Category -> Approved / Archived -> list; every item shows its category; uncategorized trainings are kept and can be assigned a category', async () => {
  const page = await get(admin, '/admin/training');
  assert.equal(page.status, 200);
  for (const label of ['Product Training', 'Sales Training', 'System &amp; Workflow Training', 'Uncategorized']) assert.ok(page.text.includes(label), label);
  // default: the first category that has something; Product has two approved
  assert.match(page.text, /class="category-tab active"[^>]*>\s*<span>Product Training<\/span><span class="category-count">2</);
  assert.ok(page.text.includes('Aircraft Cabins') && page.text.includes('Fare Families'));
  assert.ok(!page.text.includes('Handling Objections') && !page.text.includes('Legacy Course'));
  assert.match(page.text, /data-category-badge>Product Training</);
  const sales = await get(admin, '/admin/training?category=SALES');
  assert.ok(sales.text.includes('Handling Objections') && !sales.text.includes('Aircraft Cabins'));
  const archived = await get(admin, '/admin/training?category=PRODUCT&view=archived');
  assert.ok(archived.text.includes('Old Product Course') && !archived.text.includes('Aircraft Cabins'));
  assert.match(archived.text, /btn-sm btn-gold">Archived</);
  const legacy = await get(admin, '/admin/training?category=UNCATEGORIZED');
  assert.ok(legacy.text.includes('Legacy Course') && /created before categories/.test(legacy.text));
  assert.match(legacy.text, /data-category-badge>Uncategorized</);
  assert.equal((await get(admin, '/admin/training?category=bogus')).status, 200); // an unknown category falls back safely
  // a supervisor browses the same catalog (view only), without the Admin's category controls
  const supPage = await get(sup, '/admin/training?category=SALES');
  assert.equal(supPage.status, 200); assert.doesNotMatch(supPage.text, /\/category"/);
});

test('an Admin sets the category of any training (nothing is deleted or recreated); others cannot; it is audited', async () => {
  const before = await prisma.trainingCourse.count({ where: { organizationId: org.id } });
  const res = await post(admin, `/admin/training/${courses.old.id}/category`, { trainingCategory: 'SYSTEM_WORKFLOW', from: 'UNCATEGORIZED' });
  assert.equal(res.status, 302); assert.equal(res.headers.location, '/admin/training?category=SYSTEM_WORKFLOW');
  assert.equal((await prisma.trainingCourse.findUnique({ where: { id: courses.old.id } })).trainingCategory, 'SYSTEM_WORKFLOW');
  assert.equal(await prisma.trainingCourse.count({ where: { organizationId: org.id } }), before);
  assert.ok(await prisma.auditLog.findFirst({ where: { organizationId: org.id, action: 'training.category_set', targetId: courses.old.id } }));
  assert.equal((await get(admin, '/admin/training?category=UNCATEGORIZED')).text.includes('Legacy Course'), false);
  // junk is refused, others are denied
  assert.equal((await post(admin, `/admin/training/${courses.old.id}/category`, { trainingCategory: 'AIRLINES' })).status, 302);
  assert.equal((await prisma.trainingCourse.findUnique({ where: { id: courses.old.id } })).trainingCategory, 'SYSTEM_WORKFLOW');
  assert.ok([403, 404].includes((await post(sup, `/admin/training/${courses.old.id}/category`, { trainingCategory: 'SALES' })).status));
  assert.ok([403, 404].includes((await post(agent, `/admin/training/${courses.old.id}/category`, { trainingCategory: 'SALES' })).status));
  assert.equal((await prisma.trainingCourse.findUnique({ where: { id: courses.old.id } })).trainingCategory, 'SYSTEM_WORKFLOW');
  await prisma.trainingCourse.update({ where: { id: courses.old.id }, data: { trainingCategory: null } }); // back to uncategorized for the next tests
});

test('Assignments: the same category filter (All / Product / Sales / System & Workflow), a category badge, and nothing else changes', async () => {
  const assign = async (course) => { const a = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL' } }); await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: agent.id } }); return a; };
  await assign(courses.p1); await assign(courses.s1); await assign(courses.w1); await assign(courses.old);
  // only the Recent assignments list (the assign form beside it lists every course)
  const listOf = (res) => ({ ...res, text: res.text.slice(res.text.indexOf('Recent assignments'), res.text.indexOf('Assign training')) });
  const all = await get(admin, '/assignments');
  assert.equal(all.status, 200);
  for (const t of ['Aircraft Cabins', 'Handling Objections', 'CRM Statuses', 'Legacy Course']) assert.ok(listOf(all).text.includes(t), t);
  assert.match(all.text, /category-tab active"[^>]*>All</);
  const sales = listOf(await get(admin, '/assignments?category=SALES'));
  assert.ok(sales.text.includes('Handling Objections') && !sales.text.includes('Aircraft Cabins') && !sales.text.includes('CRM Statuses') && !sales.text.includes('Legacy Course'));
  assert.match(sales.text, /category-tab active"[^>]*>Sales</);
  assert.ok(listOf(await get(admin, '/assignments?category=PRODUCT')).text.includes('Aircraft Cabins'));
  assert.match(listOf(await get(admin, '/assignments?category=SYSTEM_WORKFLOW')).text, /CRM Statuses/);
  assert.match(listOf(await get(admin, '/assignments?category=nonsense')).text, /Legacy Course/); // unknown = All
  assert.match(all.text, /data-category-badge>Sales Training</);
  // assigning still works exactly as before (the assign form lists the category beside each course)
  assert.match(all.text, /Aircraft Cabins \(Product\)/);
  const res = await post(admin, '/assignments', { courseId: courses.p2.id, scope: 'INDIVIDUAL', targetProfileIds: [agent.id] });
  assert.equal(res.status, 302);
  assert.equal(await prisma.trainingAssignmentRecipient.count({ where: { profileId: agent.id, assignment: { courseId: courses.p2.id } } }), 1);
  // a Supervisor still needs the Admin's training.assign grant to open Assignments at all (permissions are unchanged)
  assert.equal((await get(sup, '/assignments?category=SALES')).status, 403);
});

test('buildMyTraining: status groups, overdue first with the days spelled out, and the category filter', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const row = (title, trainingCategory, status, dueDays, extra = {}) => ({ id: title, status, createdAt: new Date('2026-10-01'), latestAttempt: extra.latestAttempt || null, assignment: { dueDate: dueDays === null ? null : new Date(now.getTime() + dueDays * DAY), course: { title, trainingCategory, modules: [] } } });
  const list = [
    row('A overdue 3d', 'PRODUCT', 'NOT_STARTED', -3), row('B overdue 10d', 'SALES', 'IN_PROGRESS', -10), row('C todo soon', 'PRODUCT', 'NOT_STARTED', 2), row('D todo later', 'SALES', 'NOT_STARTED', 20),
    row('E in progress', 'SYSTEM_WORKFLOW', 'IN_PROGRESS', 5), row('F retake', 'PRODUCT', 'RETAKE_REQUIRED', null), row('G done', 'PRODUCT', 'COMPLETED', -30, { latestAttempt: { completedAt: new Date('2026-09-20') } }),
    row('H legacy', null, 'NOT_STARTED', null),
  ];
  assert.equal(groupOf(list[6], now), 'completed'); // a completed training is never overdue, however old its due date
  let v = buildMyTraining(list, {}, now);
  assert.equal(v.status, 'overdue');                                   // lands on what needs attention
  assert.deepEqual(v.statusTabs.map((s) => [s.key, s.count]), [['overdue', 2], ['todo', 3], ['inprogress', 2], ['completed', 1]]);
  assert.deepEqual(v.cards.map((c) => c.row.id), ['B overdue 10d', 'A overdue 3d']); // most overdue first
  assert.deepEqual(v.cards.map((c) => c.overdueText), ['10 days overdue', '3 days overdue']);
  assert.deepEqual(v.categoryTabs.map((c) => [c.label, c.count]), [['All', 2], ['Product', 1], ['Sales', 1], ['System & Workflow', 0]]);
  v = buildMyTraining(list, { status: 'overdue', category: 'SALES' }, now);
  assert.deepEqual(v.cards.map((c) => c.row.id), ['B overdue 10d']); assert.equal(v.counts.overdue, 1);
  v = buildMyTraining(list, { status: 'todo' }, now);
  assert.deepEqual(v.cards.map((c) => c.row.id), ['C todo soon', 'D todo later', 'H legacy']); // by due date; no due date last
  assert.deepEqual(buildMyTraining(list, { status: 'todo', category: 'PRODUCT' }, now).cards.map((c) => c.row.id), ['C todo soon']);
  assert.ok(buildMyTraining(list, { status: 'todo' }, now).cards.some((c) => c.category === null)); // uncategorized shows under All only
  assert.equal(buildMyTraining(list, { status: 'todo', category: 'SALES' }, now).cards.some((c) => c.row.id === 'H legacy'), false);
  v = buildMyTraining(list, { status: 'inprogress' }, now);
  assert.deepEqual(v.cards.map((c) => [c.row.id, c.retake]), [['E in progress', false], ['F retake', true]]); // a retake is started-but-not-completed
  assert.deepEqual(buildMyTraining(list, { status: 'completed' }, now).cards.map((c) => c.row.id), ['G done']);
  assert.equal(buildMyTraining(list, { status: 'junk', category: 'junk' }, now).status, 'overdue'); // unknown values fall back
  assert.equal(buildMyTraining(list.filter((r) => r.status !== 'NOT_STARTED' || r.assignment.dueDate === null), {}, now).status, 'overdue');
  assert.equal(buildMyTraining([], {}, now).status, 'todo');
  assert.equal(overdueText(new Date(now.getTime() - DAY), now), '1 day overdue');
  assert.equal(overdueText(new Date(now.getTime() - 3600000), now), 'Overdue since today');
});

test('My Training page: Overdue / To Do / In Progress / Completed, then All / Product / Sales / System & Workflow, on one page', async () => {
  const assign = async (course, dueDays, attempt) => {
    const a = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL', dueDate: dueDays === null ? null : new Date(Date.now() + dueDays * DAY) } });
    const r = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: agent.id } });
    if (attempt) await prisma.trainingAttempt.create({ data: { recipientId: r.id, profileId: agent.id, attemptNumber: 1, completedAt: attempt.status === 'COMPLETED' ? new Date() : null, score: attempt.score ?? null, status: attempt.status } });
    return r;
  };
  await prisma.trainingAssignmentRecipient.deleteMany({ where: { profileId: agent.id } });
  const mkc = (t, c) => prisma.trainingCourse.create({ data: { organizationId: org.id, title: t, createdById: admin.id, status: 'PUBLISHED', trainingCategory: c } });
  await assign(await mkc('Late product course', 'PRODUCT'), -4);
  await assign(await mkc('Late sales course', 'SALES'), -1);
  await assign(await mkc('Fresh system course', 'SYSTEM_WORKFLOW'), 9);
  await assign(await mkc('Started sales course', 'SALES'), 3, { status: 'IN_PROGRESS' });
  await assign(await mkc('Finished product course', 'PRODUCT'), -60, { status: 'COMPLETED', score: 92 });
  await assign(await mkc('Uncategorized old course', null), null);

  let page = await get(agent, '/training');
  assert.equal(page.status, 200);
  assert.match(page.text, /status-tab status-tab--overdue active/); // lands on Overdue
  for (const label of ['Overdue', 'To Do', 'In Progress', 'Completed']) assert.match(page.text, new RegExp(`<span>${label}</span><span class="category-count">\\d+<`));
  assert.deepEqual(names(page.text), ['Late product course', 'Late sales course']);   // the most overdue first
  assert.match(page.text, /class="training-card training-card--overdue/);
  assert.match(page.text, /data-overdue-badge>Overdue</);                              // the word, not only a colour
  assert.match(page.text, /Overdue — 4 days overdue/);
  assert.match(page.text, /Overdue — 1 day overdue/);
  for (const label of ['All', 'Product', 'Sales', 'System &amp; Workflow']) assert.match(page.text, new RegExp(`<span>${label}</span><span class="category-count">\\d+<`));
  assert.match(page.text, /data-category-badge>Product Training</);

  page = await get(agent, '/training?status=overdue&category=SALES');
  assert.deepEqual(names(page.text), ['Late sales course']);
  page = await get(agent, '/training?status=todo');
  assert.deepEqual(names(page.text), ['Fresh system course', 'Uncategorized old course']);
  assert.match(page.text, /data-category-badge>Uncategorized</);
  assert.deepEqual(names((await get(agent, '/training?status=todo&category=SYSTEM_WORKFLOW')).text), ['Fresh system course']);
  assert.deepEqual(names((await get(agent, '/training?status=inprogress')).text), ['Started sales course']);
  assert.match((await get(agent, '/training?status=inprogress')).text, /Continue</);
  page = await get(agent, '/training?status=completed');
  assert.deepEqual(names(page.text), ['Finished product course']);
  assert.match(page.text, /score 92%/);
  assert.doesNotMatch(page.text, /data-overdue-badge/); // completed history is never flagged overdue
  assert.match((await get(agent, '/training?status=completed&category=SALES')).text, /Completed training will appear here|Nothing here in this category/);
  assert.equal((await get(agent, '/training?status=zzz&category=zzz')).status, 200);
  // starting still works from the card
  const todo = await get(agent, '/training?status=todo');
  assert.match(todo.text, /action="\/training\/[^"]+\/start"/);
});

test('AI Practice -> Training: the upload, the review step and the send screen require / carry the category', async () => {
  // upload: a category is required for material
  const noCat = await request(app).post('/ai-practice/new').set('Cookie', cookies[admin.id]).field('kind', 'material').field('title', 'No category').field('noteText', 'Some text.');
  assert.equal(noCat.status, 400); assert.match(noCat.text, /Choose a Training Category/);
  const bad = await request(app).post('/ai-practice/new').set('Cookie', cookies[admin.id]).field('kind', 'material').field('trainingCategory', 'AIRLINES').field('noteText', 'Some text.');
  assert.equal(bad.status, 400);
  assert.match((await get(admin, '/ai-practice/new')).text, /<select id="trainingCategory" name="trainingCategory" required>/);
  const ok = await request(app).post('/ai-practice/new').set('Cookie', cookies[admin.id]).field('kind', 'material').field('trainingCategory', 'PRODUCT').field('title', 'With category').field('noteText', 'Some text.');
  assert.equal(ok.status, 302);
  const created = await prisma.trainingCourse.findFirst({ where: { organizationId: org.id, title: 'With category' } });
  assert.equal(created.trainingCategory, 'PRODUCT');

  // a course without a category cannot be sent (nor submitted for approval) - the message says what to do
  const c = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Send me', createdById: admin.id, status: 'DRAFT', origin: 'MANUAL' } });
  const blocked = await versions.sendToTraining(admin, c);
  assert.equal(blocked.ok, false); assert.match(blocked.error, /Choose a Training Category/);
  assert.equal(await versions.sendBlocker(c, { trainingCategory: 'SALES' }), null);                // a category chosen on the send screen is enough
  assert.match(await versions.sendBlocker(c, { trainingCategory: 'JUNK' }), /Training Category/);
  const sent = await versions.sendToTraining(admin, c, { trainingCategory: 'SALES' });
  assert.equal(sent.ok, true);
  const after = await prisma.trainingCourse.findUnique({ where: { id: c.id } });
  assert.equal(after.status, 'PUBLISHED'); assert.equal(after.trainingCategory, 'SALES');         // it travels with the training
  assert.equal((await get(admin, '/admin/training?category=SALES')).text.includes('Send me'), true); // ...into the Catalog
  // the review-step control and the send screen
  const d = await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'Draft to categorize', createdById: admin.id, status: 'DRAFT', origin: 'AI_PRACTICE' } });
  const set = await post(admin, `/ai-practice/${d.id}/category`, { trainingCategory: 'SYSTEM_WORKFLOW' });
  assert.equal(set.status, 302);
  assert.equal((await prisma.trainingCourse.findUnique({ where: { id: d.id } })).trainingCategory, 'SYSTEM_WORKFLOW');
  assert.match((await post(admin, `/ai-practice/${d.id}/category`, { trainingCategory: '' })).headers.location, /error=/);
  const sendPage = await get(admin, `/ai-practice/${d.id}/send`);
  assert.equal(sendPage.status, 200);
  assert.match(sendPage.text, /<select id="trainingCategory" name="trainingCategory" required>/);
  assert.match(sendPage.text, /<option value="SYSTEM_WORKFLOW" selected>System &amp; Workflow Training/);
  const noCatSend = await post(admin, `/ai-practice/${(await prisma.trainingCourse.create({ data: { organizationId: org.id, title: 'No cat send', createdById: admin.id, status: 'DRAFT', origin: 'AI_PRACTICE' } })).id}/send`, { title: 'x', passingScore: '70' });
  assert.match(noCatSend.headers.location, /error=.*Training\+Category|error=.*Training%20Category/);
  assert.ok([403, 404, 302].includes((await post(sup, `/ai-practice/${d.id}/category`, { trainingCategory: 'SALES' })).status));
});
