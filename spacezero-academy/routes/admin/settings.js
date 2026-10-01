'use strict';

// ONE Settings area for every Admin (Task 4 — merge Settings & Security + Admin Configuration):
//   General — organization settings overview. Every Admin.
//   Security — everyday access & approval policies. Every Admin.
//   Advanced — the full Admin Configuration surface (lib/adminConfigurationSections.js). Only an
//              Admin with the explicit System Configuration Access capability; hiding the tab is a
//              convenience only — every route it links to re-checks that capability itself.
const express = require('express');
const router = express.Router();

const { prisma } = require('../../lib/prisma');
const { requireAdmin } = require('../../lib/authMiddleware');
const { requireSystemConfigAccess } = require('../../lib/supervisorCapabilities');
router.use(['/settings/tenure-bands', '/settings/skills'], requireAdmin, requireSystemConfigAccess);
const { TenureBandSchema, SkillSchema } = require('../../lib/validation');
const { logAudit } = require('../../lib/audit');

const { getSetting, setSetting, DEFAULTS } = require('../../lib/orgSettings');
const { SECTIONS } = require('../../lib/adminConfigurationSections');

const POLICY_META = [
  { key: 'credentials.ownerCanView', label: 'Employees may reveal their own credentials', help: 'When off, only Admins (and the supervisor of a Travel Agent) can reveal a stored credential. Every reveal is audited either way and needs the viewer to re-enter their password.' },
  { key: 'leave.supervisorFinalApproval', label: 'Supervisors may make the final vacation decision', help: 'When off, a supervisor can only recommend approval or rejection; an Admin decides. When on, a supervisor may approve or reject requests from their own team.' },
];

async function loadPolicies(admin) {
  const policies = [];
  for (const meta of POLICY_META) policies.push({ ...meta, value: await getSetting(admin.organizationId, meta.key) });
  return policies;
}

function renderGeneralError(req, res, error) {
  if (req.path.startsWith('/settings/skills')) return require('./development').renderSkills(req, res.status(400), { error, values: req.body, saved: false });
  return require('./development').renderDevelopment(req, res.status(400), { error, values: req.body });
}
router.get('/settings', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const advanced = Boolean(res.locals.hasSystemConfigAccess); // computed once per request in server.js
  const tab = ['general', 'security', 'advanced'].includes(req.query.tab) ? req.query.tab : 'general';

  const policies = await loadPolicies(admin);
  res.render('admin/settings/index', {
    title: 'Settings',
    tab: tab === 'advanced' && !advanced ? 'general' : tab, // no protected content is ever fetched for an unauthorized visitor; this only picks the default tab
    advanced,

    policies,
    sections: SECTIONS,
    saved: req.query.saved === '1',
  });
});

router.post('/settings/tenure-bands', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const parsed = TenureBandSchema.safeParse({
    label: req.body.label,
    minMonths: req.body.minMonths,
    maxMonths: req.body.maxMonths || undefined,
    displayOrder: req.body.displayOrder || 0,
  });
  if (!parsed.success) return renderGeneralError(req, res, 'Please check the tenure band name and month values. Your changes have not been saved.');
  if (parsed.success) {
    await prisma.tenureBand.create({
      data: {
        organizationId: admin.organizationId,
        label: parsed.data.label,
        minMonths: parsed.data.minMonths,
        maxMonths: parsed.data.maxMonths ? Number(parsed.data.maxMonths) : null,
        displayOrder: parsed.data.displayOrder,
      },
    });
    await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'settings.tenure_band_created' });
  }
  res.redirect(req.path.startsWith('/settings/skills') ? '/admin/skills?saved=1' : '/admin/development?saved=1#tenure-bands');
});

router.post('/settings/tenure-bands/:id/delete', requireAdmin, async (req, res) => {
  const admin = req.profile;
  await prisma.tenureBand.deleteMany({ where: { id: req.params.id, organizationId: admin.organizationId } });
  await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'settings.tenure_band_deleted', targetId: req.params.id });
  res.json({ ok: true });
});

router.post('/settings/skills', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const parsed = SkillSchema.safeParse({
    name: req.body.name,
    roleKey: req.body.roleKey || '',
    category: req.body.category || undefined,
  });
  if (!parsed.success) return renderGeneralError(req, res, 'Please check the skill name, role and category. Your changes have not been saved.');
  if (parsed.success) {
    await prisma.skill.create({
      data: {
        organizationId: admin.organizationId,
        name: parsed.data.name,
        roleKey: parsed.data.roleKey || null,
        category: parsed.data.category,
      },
    });
    await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'settings.skill_created' });
  }
  res.redirect(req.path.startsWith('/settings/skills') ? '/admin/skills?saved=1' : '/admin/development?saved=1#tenure-bands');
});

router.post('/settings/skills/:id/deactivate', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const result = await prisma.skill.updateMany({ where: { id: req.params.id, organizationId: admin.organizationId, isActive: true }, data: { isActive: false } });
  if (result.count) await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'settings.skill_deactivated', targetTable: 'Skill', targetId: req.params.id });
  res.json({ ok: true });
});

// Everyday access & approval policies (Task 4: "do not force everyday settings into Advanced") —
// plain Admin, no System Configuration Access needed. Moved here from /admin/policies, which now
// holds only the deeper Training/Skill-scoring configuration under Settings → Advanced.
router.post('/settings/security', requireAdmin, async (req, res) => {
  const admin = req.profile;
  const changed = [];
  for (const meta of POLICY_META) {
    if (!(meta.key in DEFAULTS)) continue;
    const next = req.body[meta.key] === '1';
    if ((await getSetting(admin.organizationId, meta.key)) !== next) {
      await setSetting(admin.organizationId, meta.key, next, admin.id);
      changed.push({ key: meta.key, to: next });
    }
  }
  for (const c of changed) await logAudit({ organizationId: admin.organizationId, actorId: admin.id, action: 'policy.changed', targetTable: 'OrgSetting', targetId: c.key, metadata: c });
  res.redirect('/admin/settings?tab=security&saved=1');
});

module.exports = router;
