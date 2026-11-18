'use strict';
const { prisma } = require('./prisma');
const { getVisibleLibraryItems } = require('./library');
const { visibleStandardsItems, getItemForReading } = require('./standards');
const { parseBlocks } = require('./richContent');
const { getMyTrainingList } = require('./training');
const { visibleLeaveWhere } = require('./leave');
const { resolveStoragePath } = require('./storage');
const { stat } = require('node:fs/promises');
const { documentText } = require('./documentText');

// Product guidance, reviewed against the current routes. No secrets or employee records live here.
const GUIDES = [
  ['Getting started and account access', '/dashboard', 'Sign in with your username or email, password, and company code. Use the invitation email to activate an invited account. Forgot your password opens the reset flow. The dashboard shows the work visible to your role. Account menu contains profile and personal settings. Never share passwords, API keys, or reset links.'],
  ['Setup checklist', '/my/setup', 'My Setup shows required equipment, systems, access and other onboarding requirements. Expand an item to read its instructions, record progress or report an issue. Some items require a supervisor or administrator to verify completion; an employee confirmation alone does not complete these items. Company-controlled information must be provided by the responsible manager.'],
  ['My Training and retakes', '/training', 'Open My Training and continue the next assigned step. Read or watch required materials and finish the required practice or assessments. Mandatory content has completion checks. A failed required assessment can require a retake. Finishing one step is different from submitting all required training. Check the displayed due date and status; completed training stays in your history.'],
  ['Skill DNA', '/skill-graph', 'My Skill DNA shows measured skills, scores, evidence and confidence. Complete assigned practice to build evidence. Recommendations indicate what to practice next; a missing measurement is not a judgement about ability.'],
  ['Knowledge Library', '/library', 'Search the Library by title or browse categories. Open an item to read or watch it. Favorites and recently viewed items help you return to material. Visibility depends on role. Uploaded documents and media are viewed inside the platform.'],
  ['Company Standards and Workflow', '/standards', 'Read published standards, responsibilities, workflows and required disclosures applicable to your role. Required acknowledgement applies to the displayed published version. Workflows provide ordered steps. Use approved disclosure wording rather than inventing replacements.'],
  ['Vacation and leave', '/my/leave', 'Open My Vacation / Leave to request dates and view your own request status. A submitted request is not automatically approved. Supervisors and Admins review requests within their permitted scope.'],
  ['Space AI chat, images and voice', '/assistant', 'Space AI explains platform guidance and authorized workspace data in English. Attach one PNG, JPEG or WebP image up to 5 MB for visual help. Microphone creates an editable draft; Voice chat sends recognized speech and reads replies aloud. End voice chat stops listening. Right-click a chat or use its options button to rename, pin, archive, delete or share. Archived chats can be restored. Sharing creates a snapshot for selected signed-in coworkers; later messages are not included and the owner can revoke links. AI cannot perform business actions or reveal sign-in secrets.'],
  ['Supervisor workspace', '/team', 'Supervisors see the teams and employees they are authorized to manage. Review setup, training, retakes and standards completion. Training creation and assignment depend on the granted capabilities and course assignment policy. Review leave within your scope; do not approve your own requests.', ['SUPERVISOR']],
  ['Employees, teams and administration', '/admin/employees', 'Admins manage employees, roles, team membership, setup and training. Employees & Teams supports search and filters, employee creation and exports. Use the employee profile for its setup and assigned training. View as is a read-only view of a real employee; private AI conversations are not exposed by View as.', ['ADMIN']],
  ['Training management and AI Practice', '/admin/training', 'Manage Training provides course materials, assignment controls, due dates and assignment email controls. AI Practice can turn approved source material into practice; review and approve generated content before publishing or assigning it. Admins can manage assignments; supervisors follow course ownership and assignment permissions. Do not expose assessment answer keys to learners.', ['ADMIN', 'SUPERVISOR']],
  ['Settings and configuration', '/admin/settings', 'Settings organizes operational configuration. Advanced system configuration requires the dedicated access capability. A role alone does not imply every advanced permission. Configure policies through the appropriate settings page instead of changing employee passwords or bypassing readiness checks.', ['ADMIN']],
];

const clip = (v, n = 4500) => String(v || '').slice(0, n);
function score(doc, words) { const title = doc.title.toLowerCase(), body = doc.text.toLowerCase(); return words.reduce((n, word) => n + (title.includes(word) ? 5 : 0) + (body.includes(word) ? 1 : 0), 0); }
async function knowledgeFor(actor, question) {
  const guides = GUIDES.filter(g => !g[3] || g[3].includes(actor.role)).map(g => ({ title: g[0], href: g[1], text: g[2] }));
  const [library, standards, training] = await Promise.all([
    getVisibleLibraryItems(actor.organizationId, actor.role), visibleStandardsItems(actor.organizationId, actor.role), getMyTrainingList(actor.id),
  ]);
  const docs = library.map(item => ({ title: item.title, href: `/library/${item.id}`, text: clip(item.description, 20000), storagePath: item.storagePath }));
  for (const item of standards) {
    const full = await getItemForReading(actor.organizationId, item.id, actor.role);
    if (!full) continue;
    const v = full.currentVersion;
    const blocks = parseBlocks(v.contentJson).flatMap(b => [b.text, ...(Array.isArray(b.items) ? b.items : [])]).filter(Boolean);
    docs.push({ title: item.title, href: `/standards/${item.id}`, text: clip([v.shortDescription, ...blocks, v.disclosureWhenItApplies, v.disclosureApprovedWording, v.disclosureAdditionalInstructions, ...v.steps.map(s => `${s.title}: ${s.instruction}`), ...v.responsibilities.map(r => r.text)].filter(Boolean).join('\n'), 24000) });
  }
  const myTraining = training.filter(r => r.assignment.organizationId === actor.organizationId && r.assignment.course.organizationId === actor.organizationId && !r.assignment.course.archivedAt).map(r => ({ title: r.assignment.course.title, status: r.status, dueDate: r.assignment.dueDate, href: `/training-course/${r.assignment.courseId}` }));
  for (const row of training) {
    const c = row.assignment.course;
    if (row.assignment.organizationId !== actor.organizationId || c.organizationId !== actor.organizationId || c.archivedAt || c.status !== 'PUBLISHED') continue;
    docs.push({ title: c.title, href: `/training-course/${c.id}`, text: clip(c.description, 12000) });
    for (const m of c.modules.filter(m => m.addedInVersion <= row.assignment.courseVersion && (!m.removedInVersion || m.removedInVersion > row.assignment.courseVersion))) {
      docs.push({ title: `${c.title}: ${m.title}`, href: `/training-course/${c.id}`, text: clip(m.description, 16000), storagePath: m.storagePath });
    }
  }
  // Authorize first; rank authorized documents, then read only a small bounded set of files.
  const words = [...new Set(String(question).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])].filter(w => !['the', 'and', 'what', 'how', 'does', 'this', 'that', 'can', 'you', 'with', 'please'].includes(w));
  const ranked = docs.map(d => ({ ...d, score: score(d, words) })).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const selected = ranked.filter(d => d.score > 0).slice(0, 10);
  for (const d of selected.filter(d => d.storagePath).slice(0, 4)) {
    try {
      const filename = resolveStoragePath(d.storagePath);
      if ((await stat(filename)).size <= 5 * 1024 * 1024) d.text += '\n' + clip(await documentText(filename), 8000);
    } catch { /* Metadata remains usable when a file cannot be extracted. */ }
  }
  const documents = selected.map(d => ({ title: d.title, href: d.href, text: clip(d.text, 5500) }));
  let leave = [];
  if (/\b(leave|vacation|holiday|absence|time off)\b/i.test(question)) {
    leave = await prisma.leaveRequest.findMany({ where: { OR: [{ organizationId: actor.organizationId, profileId: actor.id }, await visibleLeaveWhere(actor)] }, select: { profile: { select: { fullName: true } }, leaveType: true, startDate: true, endDate: true, status: true }, orderBy: { startDate: 'desc' }, take: 100 });
  }
  const guideMatches = guides.filter(d => score(d, words) > 0).slice(0, 3);
  return { guides, documents, myTraining, leave, coverage: { visibleLibraryItems: library.length, publishedStandards: standards.length, retrievedDocuments: documents.length, note: 'Only matching documents are included. Images, recordings and PDFs without extracted text are not full-text searchable. Leave is limited to the 100 most recent visible requests.' }, references: [...guideMatches, ...documents].slice(0, 10).map(d => ({ title: d.title, href: d.href })) };
}
module.exports = { knowledgeFor, GUIDES };
