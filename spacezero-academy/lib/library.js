'use strict';

const path = require('path');
const { prisma } = require('./prisma');
const { containsText } = require('./textSearch');

// The kinds of material, in plain words, as people see them in the Library.
const TYPE_LABELS = { VIDEO: 'Video', AUDIO: 'Audio', PDF: 'PDF', PPT: 'Slides', DOC: 'Document', IMAGE: 'Image', NOTE: 'Note', LINK: 'Link' };
const ROLE_LABELS = { ADMIN: 'Administrators', SUPERVISOR: 'Supervisors', TRAVEL_AGENT: 'Travel Agents', FLIGHT_EXPERT: 'Flight Experts' };
const ROLES = Object.keys(ROLE_LABELS);

/** Search matches the title, the description and the tags. */
function searchFilter(q) {
  if (typeof q !== 'string' || !q.trim()) return undefined;
  return [{ title: containsText(q) }, { description: containsText(q) }, { tagsJson: containsText(q) }];
}

async function getVisibleLibraryItems(organizationId, role, filters) {
  filters = filters || {};
  const items = await prisma.libraryItem.findMany({
    where: {
      organizationId,
      archivedAt: null,
      categoryId: filters.categoryId || undefined,
      OR: searchFilter(filters.q),
    },
    include: { category: true },
    orderBy: { createdAt: 'desc' },
  });
  return items.filter((item) => isVisibleTo(item.visibleRolesJson, role));
}

function isVisibleTo(visibleRolesJson, role) {
  if (role === 'ADMIN' || !visibleRolesJson) return true;
  try { return JSON.parse(visibleRolesJson).includes(role); } catch { return false; }
}

function parseTags(tagsJson) {
  try {
    return JSON.parse(tagsJson);
  } catch {
    return [];
  }
}

function parseRoles(visibleRolesJson) {
  try { return visibleRolesJson ? JSON.parse(visibleRolesJson).filter((r) => ROLES.includes(r)) : []; } catch { return []; }
}

/** "Everyone", or the roles that can see it ("Travel Agents and Flight Experts"). */
function audienceLabel(visibleRolesJson) {
  const roles = parseRoles(visibleRolesJson);
  if (!roles.length || roles.length === ROLES.length) return 'Everyone';
  const names = roles.map((r) => ROLE_LABELS[r]);
  return names.length === 1 ? `Only ${names[0]}` : `Only ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// What an uploaded file is, from its type (or, when the browser did not say, its extension), so the person adding it
// never has to choose "PDF / VIDEO / DOC..." by hand. The upload is still checked against that type afterwards.
const BY_MIME = [
  ['VIDEO', /^video\//],
  ['AUDIO', /^audio\//],
  ['PDF', /^application\/pdf$/],
  ['PPT', /powerpoint|presentationml/],
  ['DOC', /msword|wordprocessingml/],
  ['IMAGE', /^image\//],
];
const BY_EXT = { mp4: 'VIDEO', webm: 'VIDEO', mov: 'VIDEO', mp3: 'AUDIO', wav: 'AUDIO', ogg: 'AUDIO', m4a: 'AUDIO', pdf: 'PDF', ppt: 'PPT', pptx: 'PPT', doc: 'DOC', docx: 'DOC', png: 'IMAGE', jpg: 'IMAGE', jpeg: 'IMAGE', webp: 'IMAGE', gif: 'IMAGE' };
function inferItemType(file) {
  if (!file) return null;
  const mime = String(file.mimetype || '');
  const hit = BY_MIME.find(([, re]) => re.test(mime));
  if (hit) return hit[0];
  return BY_EXT[path.extname(String(file.originalname || '')).slice(1).toLowerCase()] || null;
}

/** The roles chosen in the "Who can see it?" step: [] means everyone. */
function chosenRoles(body) {
  const list = Array.isArray(body.visibleRoles) ? body.visibleRoles : body.visibleRoles ? [body.visibleRoles] : [];
  if (body.audience === 'everyone') return [];
  return list.filter((r) => ROLES.includes(r));
}

module.exports = { getVisibleLibraryItems, isVisibleTo, parseTags, parseRoles, audienceLabel, inferItemType, chosenRoles, TYPE_LABELS, ROLE_LABELS, ROLES };
