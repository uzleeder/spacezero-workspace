'use strict';
// ONE shared Training Category (Product / Sales / System & Workflow) across the Training Catalog, Assignments,
// My Training and AI Practice -> Training; and My Training as ONE path through the learner's training.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { prisma } = require('../lib/prisma');
const { generateToken } = require('../lib/tokens');
const categories = require('../lib/trainingCategories');
const { pathOf, overdueText, dueText } = require('../lib/myTraining');
const versions = require('../lib/courseVersions');
const app = require('../server');

const DAY = 86400000;
let org, admin, sup, agent, cookies = {}, courses = {};
const get = (p, url) => request(app).get(url).set('Cookie', cookies[p.id]);
const post = (p, url, body = {}) => request(app).post(url).set('Cookie', cookies[p.id]).type('form').send(body);

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
  // only the Assigned training list (the assign form beside it lists every course)
  const listOf = (res) => ({ ...res, text: res.text.slice(res.text.indexOf('<h2>Assigned training</h2>'), res.text.indexOf('<h2>Assign training</h2>')) });
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

test('pathOf: ONE path in a fixed order - completed, then overdue (most overdue first), then started, then by due date, then no due date in assignment order', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const progress = (done, items, passed, practices) => ({ items: { done, total: items }, practices: { passed, total: practices } });
  const at = (days) => new Date(now.getTime() + days * DAY);
  const row = (title, status, dueDays, extra = {}) => ({
    id: title, status, createdAt: extra.assigned || at(-20), progress: extra.progress || progress(0, 0, 0, 0),
    attempts: extra.started ? [{ status: 'IN_PROGRESS', startedAt: extra.started, createdAt: extra.started }] : [{ status: 'NOT_STARTED', startedAt: null, createdAt: at(-20) }],
    latestAttempt: extra.latestAttempt || null,
    assignment: { courseId: 'c-' + title, dueDate: dueDays === null ? null : at(dueDays), course: { title } },
  });
  const list = [
    row('No due, assigned later', 'NOT_STARTED', null, { assigned: at(-5) }),
    row('No due, assigned first', 'NOT_STARTED', null, { assigned: at(-30) }),
    row('Due in 20 days', 'NOT_STARTED', 20),
    row('Overdue 3 days', 'NOT_STARTED', -3, { progress: progress(0, 4, 0, 1) }),
    row('Overdue 10 days', 'NOT_STARTED', -10),
    row('Started second', 'IN_PROGRESS', 5, { started: at(-2) }),
    row('Started first, retake', 'RETAKE_REQUIRED', -1, { started: at(-8), progress: progress(3, 3, 0, 1) }),
    row('Done recently', 'COMPLETED', -30, { latestAttempt: { completedAt: at(-1), score: 92 } }),
    row('Done long ago', 'COMPLETED', null, { latestAttempt: { completedAt: at(-40), score: null } }),
  ];
  const path = pathOf(list, now);
  assert.deepEqual(path.steps.map((s) => s.title), [
    'Done long ago', 'Done recently',                 // completed: oldest completion first
    'Overdue 10 days', 'Overdue 3 days', 'Started first, retake', // overdue first, started or not: the most overdue first
    'Started second',                                 // then what is already started
    'Due in 20 days',                                 // then by due date
    'No due, assigned first', 'No due, assigned later', // then no due date, in the order assigned
  ]);
  assert.deepEqual(path.steps.map((s) => s.number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual([path.total, path.doneCount, path.percent], [9, 2, 22]);
  // the current step: the most overdue training, though others were started before it
  assert.equal(path.current.title, 'Overdue 10 days');
  assert.equal(path.action, 'Start next training');
  assert.deepEqual([path.current.dueText, path.current.overdue], ['10 days overdue', true]);
  // a started training moved back keeps all its progress and opens where the learner stopped
  const moved = path.steps.find((s) => s.title === 'Started first, retake');
  assert.deepEqual([moved.started, moved.retake, moved.progressText, moved.resumeHref], [true, true, '3 of 3 items done · 0 of 1 practice passed', '/training-course/c-Started first, retake']);
  // the next 3 locked steps show; the rest fold into "+N more"
  assert.deepEqual(path.upcomingShown.map((s) => s.title), ['Overdue 3 days', 'Started first, retake', 'Started second']);
  assert.deepEqual(path.upcomingMore.map((s) => s.title), ['Due in 20 days', 'No due, assigned first', 'No due, assigned later']);
  assert.equal(path.steps.find((s) => s.title === 'Overdue 3 days').progressText, '4 items · 1 practice'); // not started: what it holds
  assert.deepEqual(path.completed.map((s) => s.completedText), ['Completed Sep 5 · ', 'Completed Oct 14 · Score 92%'].map((t) => t.replace(/ · $/, '')));
  // the same list in another order gives the same path (it never depends on how the list arrives)
  assert.deepEqual(pathOf([...list].reverse(), now).steps.map((s) => s.title), path.steps.map((s) => s.title));
  // the main button in each state
  const only = (...titles) => list.filter((r) => titles.includes(r.id));
  assert.equal(pathOf(only('Due in 20 days', 'Overdue 3 days'), now).action, 'Start training');            // the very first
  assert.equal(pathOf(only('Done recently', 'Due in 20 days'), now).action, 'Start next training');        // between trainings
  assert.equal(pathOf(only('Done recently', 'Started second'), now).action, 'Continue');                   // in progress
  const done = pathOf(only('Done recently', 'Done long ago'), now);
  assert.deepEqual([done.current, done.action, done.percent], [null, null, 100]);                          // all completed: no button
  const none = pathOf([], now);
  assert.deepEqual([none.total, none.current, none.action], [0, null, null]);                              // nothing assigned
  assert.equal(overdueText(new Date(now.getTime() - DAY), now), '1 day overdue');
  assert.equal(overdueText(new Date(now.getTime() - 3600000), now), 'Overdue today');
  assert.equal(dueText(now, now), 'Due today');
  assert.equal(dueText(new Date(now.getTime() + DAY), now), 'Due tomorrow');
  assert.equal(dueText(new Date('2027-01-05T12:00:00Z'), now), 'Due Jan 5, 2027');
});

test('My Training page: one path with one main button, the completed fold, 3 locked steps and "+N more"', async () => {
  const assign = async (title, dueDays, attempt) => {
    const course = await prisma.trainingCourse.create({ data: { organizationId: org.id, title, createdById: admin.id, status: 'PUBLISHED', trainingCategory: 'PRODUCT' } });
    const a = await prisma.trainingAssignment.create({ data: { organizationId: org.id, courseId: course.id, assignedById: admin.id, scope: 'INDIVIDUAL', dueDate: dueDays === null ? null : new Date(Date.now() + dueDays * DAY) } });
    const r = await prisma.trainingAssignmentRecipient.create({ data: { assignmentId: a.id, profileId: agent.id } });
    await prisma.trainingAttempt.create({ data: { recipientId: r.id, profileId: agent.id, attemptNumber: 1, status: attempt || 'NOT_STARTED', startedAt: attempt ? new Date() : null, completedAt: attempt === 'COMPLETED' ? new Date() : null, score: attempt === 'COMPLETED' ? 92 : null } });
  };
  await prisma.trainingAssignmentRecipient.deleteMany({ where: { profileId: agent.id } });
  await assign('Finished course', -60, 'COMPLETED');
  await assign('Started course', 3, 'IN_PROGRESS');
  for (let i = 1; i <= 6; i += 1) await assign('Later course ' + i, 10 + i);
  await assign('Late course', -4);

  const page = await get(agent, '/training');
  assert.equal(page.status, 200);
  assert.match(page.text, /<strong>1 of 9<\/strong> completed/);
  assert.match(page.text, /aria-valuenow="11"/);
  // exactly one main button, on the current step - the overdue training, ahead of the one already started
  assert.equal((page.text.match(/class="btn /g) || []).length, 1);
  const current = page.text.split('data-current-step')[1].split('</section>')[0];
  assert.match(current, /Step 2 of 9/);
  assert.match(current, /Late course/);
  assert.match(current, /4 days overdue/);
  assert.match(current, /data-main-action>Start next training</);
  // the completed fold, folded while there is something to do
  assert.match(page.text, /<details class="path-fold" data-fold="completed">\s*<summary>1 completed<\/summary>/);
  assert.match(page.text, /href="\/training-course\/[^"]+">Finished course<\/a><span>Completed [A-Z][a-z]{2} \d+ · Score 92%/);
  // the next 3 locked steps (the started one waits behind the overdue one), the rest behind "+4 more" - all locked, none a link
  const locked = [...page.text.matchAll(/class="path-locked__title">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(locked, ['Started course', 'Later course 1', 'Later course 2']);
  assert.match(page.text, /<summary>\+4 more<\/summary>/);
  assert.deepEqual([...page.text.split('data-fold="more"')[1].matchAll(/class="path-fold__title">([^<]+)</g)].map((m) => m[1]), ['Later course 3', 'Later course 4', 'Later course 5', 'Later course 6']);
  // no tabs, filters or category chips on the path
  assert.doesNotMatch(page.text, /status-tab|category-tab|segmented|class="tabs/);
});

test('My Training for every role: the same path; Skill Graph and Notes in the user menu; management stays under Manage Training', async () => {
  const menu = (html) => html.split('class="user-menu-panel"')[1].split('</div>')[0];
  const agentPage = (await get(agent, '/training')).text;
  assert.match(menu(agentPage), /href="\/training" role="menuitem">My Training</);
  assert.match(menu(agentPage), /href="\/skill-graph" role="menuitem">Skill Graph</);
  assert.match(menu(agentPage), /href="\/notes" role="menuitem">Notes</);
  assert.match(menu(agentPage), /Profile &amp; Settings/);
  assert.doesNotMatch((await get(agent, '/notes')).text, /class="tabs/); // the tab bar is gone from Notes and Skill Graph too
  assert.doesNotMatch((await get(agent, '/skill-graph')).text, /class="tabs/);
  const supPage = (await get(sup, '/training')).text;
  assert.match(menu(supPage), /href="\/training" role="menuitem">My Training</);
  assert.doesNotMatch(menu(supPage), /\/notes/);                       // Notes is for Travel Agents and Flight Experts only
  assert.match(supPage, /<span>Manage Training<\/span>/);
  assert.match(supPage, /No training assigned yet/);
  const fresh = await prisma.profile.create({ data: { organizationId: org.id, fullName: 'Fresh admin', username: 'tc_' + org.id + '_fresh', email: 'tc_' + org.id + '_fresh@example.invalid', role: 'ADMIN', status: 'ACTIVE', employmentStartDate: new Date() } });
  const t = generateToken(); await prisma.session.create({ data: { profileId: fresh.id, tokenHash: t.hash, expiresAt: new Date(Date.now() + 3600000) } }); cookies[fresh.id] = 'sz_session=' + t.raw;
  const adminPage = (await get(fresh, '/training')).text;
  assert.match(adminPage, /Nothing is assigned to you/);
  assert.match(adminPage, /<span>Manage Training<\/span>/);
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
