'use strict';

const express = require('express');
const router = express.Router();

const { prisma } = require('../lib/prisma');
const { requireRole } = require('../lib/authMiddleware');
const { recordSkillEvidence } = require('../lib/skills');
const { isSupervisorOfAgent } = require('../lib/authz');
const { SkillEvidenceSchema } = require('../lib/validation');
const { logAudit } = require('../lib/audit');

// Supervisor/admin manual skill-score adjustment — the Phase 1 stand-in for
// "future assessments will update these skills" (Phase 2's AI engine will
// write to the same EmployeeSkill/SkillEvidence/SkillScoreHistory tables).
router.post('/skills/:employeeSkillId/evidence', requireRole('ADMIN', 'SUPERVISOR'), async (req, res) => {
  const actor = req.profile;
  const employeeSkill = await prisma.employeeSkill.findUnique({
    where: { id: req.params.employeeSkillId },
    include: { profile: true },
  });
  if (!employeeSkill) return res.redirect('/dashboard');

  if (actor.role === 'SUPERVISOR') {
    const allowed = await isSupervisorOfAgent(actor.id, employeeSkill.profileId);
    if (!allowed) return res.status(403).render('forbidden');
  }

  const parsed = SkillEvidenceSchema.safeParse({ notes: req.body.notes });
  if (parsed.success) {
    await recordSkillEvidence({
      employeeSkillId: employeeSkill.id,
      recordedById: actor.id,
      notes: parsed.data.notes,
    });
    await logAudit({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'skill.evidence_recorded',
      targetTable: 'EmployeeSkill',
      targetId: employeeSkill.id,
    });
  }

  res.redirect('/dashboard');
});

module.exports = router;
