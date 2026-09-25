'use strict';

const { prisma } = require('./prisma');
const { canViewProfile, supervisedProfileIds, teamIdsForSupervisor } = require('./authz');
const { logAudit } = require('./audit');
const { canAssignCourse } = require('./trainingPermissions');

function visibleTo(item, actor) {
  if (!item || item.organizationId !== actor.organizationId || item.archivedAt) return false;
  if (actor.role === 'ADMIN' || !item.visibleRolesJson) return true;
  try { return JSON.parse(item.visibleRolesJson).includes(actor.role); } catch { return false; }
}

// Object IDs are always resolved independently of the UI. Route role checks
// remain in place; this boundary adds organization and relationship checks.
//
// Several route handlers (e.g. admin/employees.js setStatus/resend-invite/
// reset-password, admin/teams.js archive, admin/library.js archive,
// library.js favorite, team.js call-review recording, skills.js evidence)
// do NOT repeat an org/ownership check inline — they rely entirely on a
// matching pattern here. When adding a new route with an ID param, add a
// matching pattern below (or add an inline org/ownership check in the
// handler); an unmatched path falls through with no protection from this
// module.
async function objectAccess(req, res, next) {
  const actor = req.profile;
  if (!actor) return next();
  let match;
  let target;
  let table;
  let allowed = true;
  const url = req.path;
  // The collection export has its own admin and organization checks in the route.
  const employeeExport = req.method === 'GET' && url === '/admin/employees/export.xlsx';
  if ((match = url.match(/^\/admin\/employees\/([^/]+)(?:\/.*)?$/)) && !['new', 'invite-pending'].includes(match[1]) && !employeeExport) {
    table = 'Profile'; target = await prisma.profile.findUnique({ where: { id: match[1] } });
    allowed = actor.role === 'ADMIN' && target?.organizationId === actor.organizationId;
  } else if ((match = url.match(/^\/admin\/teams\/([^/]+)\/archive$/))) {
    table = 'Team'; target = await prisma.team.findUnique({ where: { id: match[1] } });
    allowed = actor.role === 'ADMIN' && target?.organizationId === actor.organizationId;
  } else if ((match = url.match(/^\/admin\/library\/items\/([^/]+)\/archive$/))) {
    table = 'LibraryItem'; target = await prisma.libraryItem.findUnique({ where: { id: match[1] } });
    allowed = actor.role === 'ADMIN' && target?.organizationId === actor.organizationId;
  } else if ((match = url.match(/^\/admin\/training\/([^/]+)(?:\/.*)?$/)) && match[1] !== 'new') {
    table = 'TrainingCourse'; target = await prisma.trainingCourse.findUnique({ where: { id: match[1] } });
    allowed = target?.organizationId === actor.organizationId && (actor.role === 'ADMIN' || (actor.role === 'SUPERVISOR' && target.createdById === actor.id)
      // Supervisors may VIEW (read-only) an approved course in the catalog; every mutation stays owner/admin only.
      || (actor.role === 'SUPERVISOR' && req.method === 'GET' && url === '/admin/training/' + match[1] && target.status === 'PUBLISHED'));
  } else if ((match = url.match(/^\/(?:library|library-file)\/([^/]+)(?:\/favorite)?$/)) && match[1] !== 'mine') {
    table = 'LibraryItem'; target = await prisma.libraryItem.findUnique({ where: { id: match[1] } });
    allowed = visibleTo(target, actor);
  } else if ((match = url.match(/^\/skills\/([^/]+)\/evidence$/))) {
    table = 'EmployeeSkill'; target = await prisma.employeeSkill.findUnique({ where: { id: match[1] }, include: { skill: true } });
    allowed = target && target.skill.organizationId === actor.organizationId && ['ADMIN', 'SUPERVISOR'].includes(actor.role) && await canViewProfile(actor, target.profileId);
  } else if ((match = url.match(/^\/training\/([^/]+)\/(start|complete|retake)$/))) {
    table = 'TrainingAssignmentRecipient'; target = await prisma.trainingAssignmentRecipient.findUnique({ where: { id: match[1] }, include: { assignment: { include: { course: true } } } });
    allowed = target && target.assignment.organizationId === actor.organizationId && target.assignment.course.organizationId === actor.organizationId;
    if (allowed) allowed = match[2] === 'retake' ? ['ADMIN', 'SUPERVISOR'].includes(actor.role) && await canViewProfile(actor, target.profileId) : target.profileId === actor.id;
  } else if ((match = url.match(/^\/call-reviews\/([^/]+)\/recording$/))) {
    table = 'CallReview'; target = await prisma.callReview.findUnique({ where: { id: match[1] } });
    allowed = target?.organizationId === actor.organizationId && ['ADMIN', 'SUPERVISOR'].includes(actor.role) && await canViewProfile(actor, target.agentId);
  } else if ((match = url.match(/^\/team\/([^/]+)$/))) {
    table = 'Profile'; target = { id: match[1] };
    allowed = actor.role === 'SUPERVISOR' && await canViewProfile(actor, target.id);
  } else if ((match = url.match(/^\/certificates\/([^/]+)$/))) {
    table = 'Certificate'; target = await prisma.certificate.findUnique({ where: { id: match[1] }, include: { profile: true } });
    allowed = target && target.profile.organizationId === actor.organizationId && await canViewProfile(actor, target.profileId);
  }
  if (table) {
    await logAudit({ organizationId: actor.organizationId, actorId: actor.id, action: allowed ? `access.${req.method === 'GET' ? 'read' : 'mutation_requested'}` : 'access.denied', targetTable: table, targetId: match[1], metadata: { method: req.method } });
    if (!allowed) return res.status(404).send('Not found');
  }

  // Non-multipart relationship IDs must be checked before any writes.
  if (req.method === 'POST' && /^\/admin\/employees\/(new|[^/]+)$/.test(url)) {
    const { teamId, supervisorId } = req.body;
    if (teamId && !await prisma.team.findFirst({ where: { id: teamId, organizationId: actor.organizationId, archivedAt: null } })) return res.status(400).send('Invalid team');
    if (supervisorId && !await prisma.profile.findFirst({ where: { id: supervisorId, organizationId: actor.organizationId, role: 'SUPERVISOR', status: 'ACTIVE' } })) return res.status(400).send('Invalid supervisor');
  }
  if (req.method === 'POST' && url === '/assignments') {
    const course = await prisma.trainingCourse.findFirst({ where: { id: req.body.courseId || '', organizationId: actor.organizationId, status: 'PUBLISHED', archivedAt: null }, include: { createdBy: true } });
    if (!course || !['ADMIN', 'SUPERVISOR'].includes(actor.role)) return res.status(404).send('Not found');
    // Viewing a training never implies permission to assign it: the Admin's per-training policy decides.
    if (!await canAssignCourse(actor, course)) return res.status(403).send('Forbidden');
    let ids = [].concat(req.body.targetProfileIds || []);
    if (req.body.scope === 'TEAM') {
      // One or several teams. Every team ID is checked; a supervisor's teams must be their own.
      const teamIds = [...new Set([].concat(req.body.targetTeamIds || [], req.body.targetTeamId || []).map(String))];
      if (!teamIds.length || teamIds.length > 30) return res.status(400).send('Select a team');
      const own = actor.role === 'SUPERVISOR' ? await supervisedProfileIds(actor.id) : null;
      const mine = actor.role === 'SUPERVISOR' ? await teamIdsForSupervisor(actor.id) : null;
      req.authorizedTeamRecipients = new Map();
      ids = [];
      for (const teamId of teamIds) {
        const team = await prisma.team.findFirst({ where: { id: teamId, organizationId: actor.organizationId, archivedAt: null }, include: { memberships: true } });
        if (!team) return res.status(404).send('Not found');
        if (mine && !mine.includes(team.id)) return res.status(403).send('Forbidden');
        // Resolve each team assignment into precisely the authorized recipients.
        const members = team.memberships.map((m) => m.profileId).filter((id) => !own || own.includes(id));
        req.authorizedTeamRecipients.set(team.id, members);
        ids.push(...members);
      }
    } else if ((req.body.scope === 'ROLE' || req.body.scope === 'COMPANY') && actor.role !== 'ADMIN') {
      return res.status(403).send('Forbidden'); // role groups and company-wide are Admin-only
    }
    for (const id of ids) if (!await canViewProfile(actor, id)) return res.status(403).send('Forbidden');
  }
  next();
}

module.exports = { objectAccess, visibleTo };
