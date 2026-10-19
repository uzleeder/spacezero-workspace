'use strict';

// Step 1 of guided training creation: who the training is for, and the organization's passing-score
// minimum. The intended audience is guidance for whoever assigns the training — it never assigns
// anything by itself. Every id is checked against the caller's organization.
const { prisma } = require('./prisma');
const { getSetting } = require('./orgSettings');
const { excludeOtherAdminsTestProfiles } = require('./loginAsScope');
const { parseDay } = require('./leave');

const ROLES = ['TRAVEL_AGENT', 'FLIGHT_EXPERT', 'SUPERVISOR', 'ADMIN'];
const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === '' ? [] : [v]).map(String);

/** Reads roles / teams / employees / due date from a form body. Returns { data } or { error }. */
async function readAudience(actor, body) {
  const roles = asList(body.audienceRoles).filter((r) => ROLES.includes(r));
  const [teams, people] = await Promise.all([
    asList(body.audienceTeamIds).length ? prisma.team.findMany({ where: { id: { in: asList(body.audienceTeamIds) }, organizationId: actor.organizationId, archivedAt: null }, select: { id: true } }) : [],
    asList(body.audienceProfileIds).length ? prisma.profile.findMany({ where: { id: { in: asList(body.audienceProfileIds) }, organizationId: actor.organizationId, status: { not: 'ARCHIVED' }, ...excludeOtherAdminsTestProfiles(actor) }, select: { id: true } }) : [],
  ]);
  let dueDate = null;
  if (body.dueDate) {
    dueDate = parseDay(String(body.dueDate));
    if (!dueDate) return { error: 'Enter a valid due date.' };
    if (dueDate < parseDay(new Date().toISOString().slice(0, 10))) return { error: 'The due date cannot be in the past.' };
  }
  const audience = { roles, teamIds: teams.map((t) => t.id), profileIds: people.map((p) => p.id) };
  const empty = !roles.length && !audience.teamIds.length && !audience.profileIds.length;
  return { data: { audienceJson: empty ? null : JSON.stringify(audience), dueDate, roleKey: roles.length === 1 ? roles[0] : null } };
}

const parseAudience = (course) => { try { return course.audienceJson ? JSON.parse(course.audienceJson) : { roles: [], teamIds: [], profileIds: [] }; } catch { return { roles: [], teamIds: [], profileIds: [] }; } };

/** Human-readable audience with team and employee names (only for the ids that still exist in the org). */
async function describeAudience(actor, course) {
  const a = parseAudience(course);
  const [teams, people] = await Promise.all([
    a.teamIds.length ? prisma.team.findMany({ where: { id: { in: a.teamIds }, organizationId: actor.organizationId }, select: { id: true, name: true } }) : [],
    a.profileIds.length ? prisma.profile.findMany({ where: { id: { in: a.profileIds }, organizationId: actor.organizationId }, select: { id: true, fullName: true } }) : [],
  ]);
  return { roles: a.roles, teams, people, isEmpty: !a.roles.length && !teams.length && !people.length };
}

/** The lowest passing score this organization allows for mandatory training (Admin-configurable, default 70). */
async function checkPassingScore(organizationId, score) {
  const minimum = await getSetting(organizationId, 'training.minPassingScore');
  return score < minimum ? `Passing score cannot be below the organization minimum of ${minimum}%.` : null;
}

module.exports = { readAudience, parseAudience, describeAudience, checkPassingScore, ROLES };