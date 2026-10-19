'use strict';

// The real Above9 employee directory: who works here, their role, company email, and which
// Supervisor's team each Travel Agent belongs to. Nothing is invented — no phone numbers, addresses,
// passwords, credentials or account details. Everyone created here is INVITED with NO password and
// NO invitation e-mail is sent: an Admin activates each person from Employees & Teams (Resend
// invite), and the employee then creates their own password.
//
// applyDirectory() is idempotent and non-destructive: it matches existing people by e-mail (then by
// exact name), corrects a wrong e-mail or team, creates only the people who are missing, and never
// deletes anyone. Company e-mails follow firstname.lastname@above9.travel in lowercase, with the
// listed exceptions (Ali, Zak) and the e-mail addresses given explicitly below. E-mail addresses are
// stored lowercase — matching is case-insensitive, so Ali@above9.travel is the same address.
const DOMAIN = 'above9.travel';

const ADMINS = [
  { fullName: 'Ali Ahmed', email: 'ali@above9.travel' },
  { fullName: 'Tom Allen', email: 'tom.allen@above9.travel' },
  { fullName: 'Joe Godwin', email: 'joe.goodwin@above9.travel' },
];

const SUPERVISORS = [
  { fullName: 'Adam Wilson', email: 'adam.wilson@above9.travel' },
  { fullName: 'David Nelson', email: 'david.nelson@above9.travel' },
  { fullName: 'Enzo Antony', email: 'enzo.antony@above9.travel' },
  { fullName: 'Fred Marco', email: 'fred.marco@above9.travel' },
  { fullName: 'Charlie Young', email: 'charlie.young@above9.travel' },
];

// Flight Experts are NOT Travel Agents: they are never placed in a Travel Agent team.
const FLIGHT_EXPERTS = [
  { fullName: 'Oscar Ian', email: 'oscar.ian@above9.travel' },
  { fullName: 'Lisa Brown', email: 'lisa.brown@above9.travel' },
  { fullName: 'Jason Cooper', email: 'jason.cooper@above9.travel' },
];

const agent = (fullName, email) => ({ fullName, email: email || `${fullName.toLowerCase().replace(/\s+/g, '.')}@${DOMAIN}` });

const TEAMS = [
  { name: 'Team Enzo', supervisor: 'enzo.antony@above9.travel', agents: [agent('Chris Edward'), agent('Gizelle Moreno'), agent('Oliver Hunt'), agent('Mark Terrell'), agent('Layla Noor'), agent('Patrick Johnson'), agent('Alan Brown'), agent('Brandon Lee')] },
  { name: 'Team David', supervisor: 'david.nelson@above9.travel', agents: [agent('Travis Irvin'), agent('Raphael Blaze'), agent('Ashley Taylor'), agent('Robert Murphy'), agent('James Cole'), agent('Saul Goodman'), agent('Jacob Black'), agent('Paul Harrison')] },
  { name: 'Team Fred', supervisor: 'fred.marco@above9.travel', agents: [agent('Zak Johnson', 'zak@above9.travel'), agent('Martin Green'), agent('Mason White'), agent('Camilla Zane'), agent('Brian Miller'), agent('Jeff William')] },
  { name: 'Team Adam', supervisor: 'adam.wilson@above9.travel', agents: [agent('Ella Jones'), agent('Abraham Moore'), agent('Denzel Curtis'), agent('Shawn Hunter'), agent('Eric Morgan'), agent('Kevin Turner'), agent('Ryan Brooks'), agent('Michael Nolan')] },
  { name: 'Team Charlie', supervisor: 'charlie.young@above9.travel', agents: [agent('Leon Bradley'), agent('Pablo Gibson'), agent('Sam Hawkins'), agent('Luis Smith')] },
];

/** The flat list of everyone in the directory, with role and (for agents/supervisors) team. */
function directoryPeople() {
  const teamOf = new Map();
  for (const team of TEAMS) {
    teamOf.set(team.supervisor, team);
    for (const a of team.agents) teamOf.set(a.email, team);
  }
  return [
    ...ADMINS.map((p) => ({ ...p, role: 'ADMIN', team: null })),
    ...SUPERVISORS.map((p) => ({ ...p, role: 'SUPERVISOR', team: teamOf.get(p.email) || null })),
    ...FLIGHT_EXPERTS.map((p) => ({ ...p, role: 'FLIGHT_EXPERT', team: null })),
    ...TEAMS.flatMap((team) => team.agents.map((p) => ({ ...p, role: 'TRAVEL_AGENT', team }))),
  ];
}

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,29}$/;

/**
 * @param prisma        a PrismaClient
 * @param organizationId  the organization to reconcile
 * @param options.dryRun  compute and report the changes without writing anything
 * @returns a report of what was created / corrected / left alone
 */
async function applyDirectory(prisma, organizationId, { dryRun = false } = {}) {
  const report = { created: [], emailFixed: [], teamsCreated: [], moved: [], supervisorFixed: [], expertsRemovedFromAgentTeams: [], conflicts: [], unchanged: 0 };
  const write = async (fn) => { if (!dryRun) await fn(); };
  const people = directoryPeople();

  const existing = await prisma.profile.findMany({ where: { organizationId, testOwnerAdminId: null } });
  const byEmail = new Map(existing.map((p) => [p.email.toLowerCase(), p]));
  const byName = new Map();
  for (const p of existing) byName.set(p.fullName.trim().toLowerCase(), [...(byName.get(p.fullName.trim().toLowerCase()) || []), p]);
  const usedUsernames = new Set((await prisma.profile.findMany({ select: { username: true } })).map((p) => p.username));
  const usedEmails = new Set((await prisma.profile.findMany({ select: { email: true } })).map((p) => p.email.toLowerCase()));

  // ---- teams
  const teams = new Map();
  for (const team of TEAMS) {
    let row = await prisma.team.findFirst({ where: { organizationId, name: team.name, archivedAt: null } });
    if (!row) {
      report.teamsCreated.push(team.name);
      row = dryRun ? { id: `dry:${team.name}`, name: team.name } : await prisma.team.create({ data: { organizationId, name: team.name, description: `${team.name} — supervised Travel Agents` } });
    }
    teams.set(team.name, row);
  }

  // ---- people
  const resolved = new Map(); // email -> profile row
  for (const person of people) {
    let row = byEmail.get(person.email);
    if (!row) {
      const sameName = (byName.get(person.fullName.toLowerCase()) || []).filter((p) => p.role === person.role);
      if (sameName.length === 1) row = sameName[0];
      else if (sameName.length > 1) { report.conflicts.push(`${person.fullName}: several accounts share this name — left untouched`); continue; }
    }
    if (row && row.role !== person.role) { report.conflicts.push(`${person.fullName}: exists as ${row.role}, directory says ${person.role} — left untouched`); resolved.set(person.email, row); continue; }

    if (!row) {
      let username = person.email.split('@')[0];
      if (!USERNAME.test(username)) username = `${username}.x`.slice(0, 30);
      for (let n = 2; usedUsernames.has(username); n += 1) username = `${person.email.split('@')[0]}${n}`.slice(0, 30);
      usedUsernames.add(username);
      usedEmails.add(person.email);
      report.created.push(`${person.fullName} <${person.email}> (${person.role})`);
      // employmentStartDate is required by the schema; the real hire date is not known, so the day of import is used — an Admin corrects it in the profile.
      row = dryRun ? { id: `dry:${person.email}`, ...person } : await prisma.profile.create({ data: { organizationId, fullName: person.fullName, username, email: person.email, role: person.role, status: 'INVITED', employmentStartDate: new Date() } });
    } else if (row.email.toLowerCase() !== person.email) {
      if (usedEmails.has(person.email)) { report.conflicts.push(`${person.fullName}: ${person.email} is already used by another account`); }
      else {
        report.emailFixed.push(`${person.fullName}: ${row.email} → ${person.email}`);
        usedEmails.add(person.email);
        await write(() => prisma.profile.update({ where: { id: row.id }, data: { email: person.email } }));
      }
    } else {
      report.unchanged += 1;
    }
    resolved.set(person.email, row);
  }

  // ---- team membership + supervisor assignment
  const teamRows = [...teams.values()];
  const teamIds = teamRows.map((t) => t.id);
  for (const team of TEAMS) {
    const teamRow = teams.get(team.name);
    const supervisor = resolved.get(team.supervisor);
    if (supervisor && supervisor.role === 'SUPERVISOR' && !dryRun) {
      const has = await prisma.teamMembership.findFirst({ where: { profileId: supervisor.id, teamId: teamRow.id } });
      if (!has) await prisma.teamMembership.create({ data: { profileId: supervisor.id, teamId: teamRow.id } });
    }
    for (const a of team.agents) {
      const row = resolved.get(a.email);
      if (!row || row.role !== 'TRAVEL_AGENT' || !supervisor || dryRun || String(row.id).startsWith('dry:')) continue;
      const memberships = await prisma.teamMembership.findMany({ where: { profileId: row.id } });
      const wrong = memberships.filter((m) => teamIds.includes(m.teamId) && m.teamId !== teamRow.id);
      if (wrong.length) {
        report.moved.push(`${a.fullName}: moved to ${team.name}`);
        await prisma.teamMembership.deleteMany({ where: { id: { in: wrong.map((m) => m.id) } } });
      }
      if (!memberships.some((m) => m.teamId === teamRow.id)) await prisma.teamMembership.create({ data: { profileId: row.id, teamId: teamRow.id } });

      const active = await prisma.supervisorAssignment.findMany({ where: { agentId: row.id, unassignedAt: null } });
      if (!active.some((s) => s.supervisorId === supervisor.id) || active.length > 1) {
        const stale = active.filter((s) => s.supervisorId !== supervisor.id);
        if (stale.length) { report.supervisorFixed.push(`${a.fullName}: supervisor is now ${team.supervisor.split('@')[0]}`); await prisma.supervisorAssignment.updateMany({ where: { id: { in: stale.map((s) => s.id) } }, data: { unassignedAt: new Date() } }); }
        if (!active.some((s) => s.supervisorId === supervisor.id)) {
          if (!stale.length) report.supervisorFixed.push(`${a.fullName}: assigned to ${team.supervisor.split('@')[0]}`);
          await prisma.supervisorAssignment.create({ data: { supervisorId: supervisor.id, agentId: row.id, teamId: teamRow.id } });
        }
      } else if (active[0].teamId !== teamRow.id) {
        await prisma.supervisorAssignment.update({ where: { id: active[0].id }, data: { teamId: teamRow.id } });
      }
    }
  }
  // Flight Experts never sit in a Travel Agent team.
  if (!dryRun) {
    for (const fe of FLIGHT_EXPERTS) {
      const row = resolved.get(fe.email);
      if (!row || row.role !== 'FLIGHT_EXPERT') continue;
      const bad = await prisma.teamMembership.findMany({ where: { profileId: row.id, teamId: { in: teamIds } } });
      if (bad.length) { report.expertsRemovedFromAgentTeams.push(fe.fullName); await prisma.teamMembership.deleteMany({ where: { id: { in: bad.map((m) => m.id) } } }); }
    }
  }
  return report;
}

module.exports = { DOMAIN, ADMINS, SUPERVISORS, FLIGHT_EXPERTS, TEAMS, directoryPeople, applyDirectory };
