'use strict';

// Space AI chats: each person's own conversations (like any AI chat app: a history, new chat, delete).
// Only the owner ever opens a chat. Follow-ups use recent conversation context, but answers must still come
// from fresh facts that person may see (lib/spacezeroAI.js).
const { prisma } = require('./prisma');
const { answerQuestion } = require('./spacezeroAI');
const { saveUpload, resolveStoragePath } = require('./storage');
const { readFile, unlink } = require('node:fs/promises');
const { randomBytes } = require('node:crypto');

const TEXT = {
  unknown: "I couldn't find enough SpaceZero data to answer that.",
  technical: "Space AI couldn't answer just now because of a technical problem.",
  limit: 'Too many questions in a short time. Please wait a few minutes and try again.',
};

const titleOf = (question) => {
  const q = String(question).replace(/\s+/g, ' ').trim();
  return q.length > 60 ? q.slice(0, 57).trimEnd() + '…' : q;
};
const arrayJson = value => { try { const out = JSON.parse(value || '[]'); return Array.isArray(out) ? out : []; } catch { return []; } };
const meta = c => ({ id: c.id, title: c.title, isPinned: c.isPinned, isArchived: c.isArchived, updatedAt: c.updatedAt });
const scope = actor => ({ profileId: actor.id, organizationId: actor.organizationId });
const safeImageName = name => Array.from(String(name || 'image')).map(c => c.charCodeAt(0) < 32 || '/\\'.includes(c) ? '_' : c).join('').slice(0, 160);
const shape = (m) => ({ id: m.id, role: m.role, kind: m.kind, content: m.content, createdAt: m.createdAt, sources: arrayJson(m.sourcesJson), image: m.imagePath ? { name: m.imageName, url: `/assistant/images/${m.id}`, mimeType: m.imageMime } : null });

/** The owner's chats, newest first. */
function listChats(actor, take = 41, skip = 0, archived = false) {
  return prisma.aiChat.findMany({ where: { ...scope(actor), isArchived: archived }, orderBy: [{ isPinned: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }], take, skip, select: { id: true, title: true, updatedAt: true, isPinned: true, isArchived: true } });
}

/** One chat with its messages, only for its owner (anyone else gets null). */
async function getChat(actor, chatId) {
  if (!chatId) return null;
  const chat = await prisma.aiChat.findFirst({ where: { id: String(chatId), profileId: actor.id, organizationId: actor.organizationId }, include: { messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
  return chat ? { ...meta(chat), messages: chat.messages.map(shape) } : null;
}

/** What Space AI says back: a real answer, or which kind of "I can't" (no data / technical / too many questions). */
async function reply(actor, question, { allowed, history, image }) {
  if (!allowed) return { kind: 'limit', content: TEXT.limit };
  let result;
  try { result = await answerQuestion(actor, question, { history, image }); }
  catch { return { kind: 'technical', content: TEXT.technical }; }
  if (result.confident && result.answer) return { kind: 'answer', content: String(result.answer), sources: result.sources || [] };
  const technicalQuestion = /\b(technical|bug|crash|error|not (?:working|loading|playing)|won't (?:load|play|open))\b/i.test(question);
  if (result.technical) return { kind: 'technical', content: TEXT.technical };
  return { kind: technicalQuestion ? 'technical' : 'unknown', content: TEXT.unknown };
}

/**
 * Asks Space AI inside a chat (a new chat when chatId is empty). save:false (an Admin viewing someone's account)
 * answers without keeping anything. Returns { chat, messages: [question, reply], status }.
 */
async function ask(actor, { chatId, question, allowed = true, save = true, imageFile = null }) {
  const q = String(question || '').trim().slice(0, 500);
  const existing = save && chatId ? await getChat(actor, chatId) : null;
  if (save && chatId && !existing) return { status: 404, error: 'Chat not found. Start a new chat.' };
  if (existing?.isArchived) return { status: 409, error: 'Restore this archived chat before sending a message.' };
  const history = existing ? existing.messages.filter(m => m.kind === 'answer').slice(-12) : [];
  let image = imageFile ? { buffer: imageFile.buffer, mimeType: imageFile.mimetype } : null;
  if (!image && existing && allowed) {
    const previous = await prisma.aiChatMessage.findFirst({ where: { chatId: existing.id, imagePath: { not: null } }, orderBy: { createdAt: 'desc' } });
    if (previous) { try { image = { buffer: await readFile(resolveStoragePath(previous.imagePath)), mimeType: previous.imageMime }; } catch { /* Prior image may no longer be available. */ } }
  }
  const answer = await reply(actor, q, { allowed, history, image });
  const status = answer.kind === 'limit' ? 429 : 200;
  const now = new Date();
  if (!save || answer.kind === 'limit') {
    return { status, chat: null, messages: [{ role: 'user', kind: 'answer', content: q, createdAt: now }, { role: 'assistant', ...answer, createdAt: now }] };
  }
  const uploaded = imageFile ? await saveUpload(imageFile, 'ai-chat-images') : null;
  try { return await prisma.$transaction(async tx => {
    const chat = existing || await tx.aiChat.create({ data: { organizationId: actor.organizationId, profileId: actor.id, title: titleOf(q) } });
    const asked = await tx.aiChatMessage.create({ data: { chatId: chat.id, role: 'user', content: q, createdAt: now, ...(uploaded ? { imagePath: uploaded.storagePath, imageMime: imageFile.mimetype, imageName: safeImageName(imageFile.originalname) } : {}) } });
    const said = await tx.aiChatMessage.create({ data: { chatId: chat.id, role: 'assistant', kind: answer.kind, content: answer.content, sourcesJson: JSON.stringify(answer.sources || []), createdAt: new Date(now.getTime() + 1) } });
    await tx.aiChat.update({ where: { id: chat.id }, data: { updatedAt: new Date() } });
    return { status, chat: meta(chat), messages: [shape(asked), shape(said)] };
  }); } catch (err) { if (uploaded) await unlink(resolveStoragePath(uploaded.storagePath)).catch(() => {}); throw err; }
}

/** Deletes one of the owner's chats. Returns true when something was deleted. */
async function deleteChat(actor, chatId) {
  const files = await prisma.$transaction(async tx => {
    const chat = await tx.aiChat.findFirst({ where: { id: String(chatId || ''), ...scope(actor) }, include: { messages: { select: { imagePath: true } } } });
    if (!chat) return null;
    await tx.aiChat.delete({ where: { id: chat.id } });
    return chat.messages.filter(m => m.imagePath).map(m => m.imagePath);
  });
  if (!files) return false;
  await Promise.allSettled(files.map(p => unlink(resolveStoragePath(p))));
  return true;
}

async function changeChat(actor, id, action, title) {
  const chat = await getChat(actor, id);
  if (!chat) return null;
  let data;
  if (action === 'rename') {
    const name = String(title || '').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 100) throw Object.assign(new Error('Enter a chat name between 1 and 100 characters.'), { status: 400 });
    data = { title: name };
  } else if (action === 'pin') data = { isPinned: !chat.isPinned };
  else if (action === 'archive') data = { isArchived: !chat.isArchived };
  else return null;
  return meta(await prisma.aiChat.update({ where: { id }, data }));
}

async function sharingOptions(actor, id) {
  if (!await getChat(actor, id)) return null;
  const [people, shares] = await Promise.all([
    prisma.profile.findMany({ where: { organizationId: actor.organizationId, status: 'ACTIVE', id: { not: actor.id }, testOwnerAdminId: null }, select: { id: true, fullName: true, role: true }, orderBy: { fullName: 'asc' } }),
    prisma.aiChatShare.findMany({ where: { chatId: id }, select: { id: true, token: true, recipientIdsJson: true, createdAt: true }, orderBy: { createdAt: 'desc' } }),
  ]);
  return { people, shares: shares.map(s => ({ id: s.id, path: `/assistant/shared/${s.token}`, recipientIds: arrayJson(s.recipientIdsJson), createdAt: s.createdAt })) };
}

async function shareChat(actor, id, recipientIds) {
  const chat = await getChat(actor, id);
  if (!chat) return null;
  const ids = [...new Set([].concat(recipientIds || []).map(String))];
  if (!ids.length || ids.length > 20) throw Object.assign(new Error('Choose between 1 and 20 coworkers.'), { status: 400 });
  const count = await prisma.profile.count({ where: { id: { in: ids, not: actor.id }, organizationId: actor.organizationId, status: 'ACTIVE', testOwnerAdminId: null } });
  if (count !== ids.length) throw Object.assign(new Error('Choose active coworkers from your workspace.'), { status: 400 });
  const s = await prisma.aiChatShare.create({ data: { chatId: id, token: randomBytes(32).toString('hex'), recipientIdsJson: JSON.stringify(ids), snapshotJson: JSON.stringify({ title: chat.title, messages: chat.messages }) } });
  return { id: s.id, path: `/assistant/shared/${s.token}` };
}
async function sharedChat(actor, token) {
  const s = await prisma.aiChatShare.findUnique({ where: { token: String(token) }, include: { chat: { select: { organizationId: true, profileId: true, profile: { select: { fullName: true } } } } } });
  if (!s || s.chat.organizationId !== actor.organizationId || (s.chat.profileId !== actor.id && !arrayJson(s.recipientIdsJson).includes(actor.id))) return null;
  const snapshot = JSON.parse(s.snapshotJson);
  snapshot.messages.forEach(m => { if (m.image) m.image.url = `/assistant/shared/${s.token}/images/${m.id}`; });
  return { ...snapshot, sharedBy: s.chat.profile.fullName, createdAt: s.createdAt };
}
async function revokeShare(actor, chatId, id) {
  return prisma.aiChatShare.deleteMany({ where: { id, chatId, chat: scope(actor) } });
}
async function imageFor(actor, id, shareToken) {
  if (shareToken) {
    const snapshot = await sharedChat(actor, shareToken);
    if (!snapshot?.messages.some(m => m.id === id && m.image)) return null;
    return prisma.aiChatMessage.findFirst({ where: { id, imagePath: { not: null } }, select: { imagePath: true, imageMime: true } });
  }
  return prisma.aiChatMessage.findFirst({ where: { id, imagePath: { not: null }, chat: scope(actor) }, select: { imagePath: true, imageMime: true } });
}
module.exports = { listChats, getChat, ask, deleteChat, changeChat, sharingOptions, shareChat, sharedChat, revokeShare, imageFor, TEXT };
