'use strict';

// Personalized development engine ("What should I do next?"). DETERMINISTIC: it reads the employee's
// assignments, attempts, skill aggregates, trends and open recommendations and ranks what to do.
// Every recommendation carries a reason built only from stored evidence — nothing is invented and no
// AI decides anything here. Only skills that apply to the employee's role are ever considered, so a
// Flight Expert is never sent sales practice (and vice versa).
const { prisma } = require('./prisma');
const { getSetting } = require('./orgSettings');
const { getSkillRows } = require('./skillIntel');

const DAY_MS = 86400000;
const parse = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

/** Rough time to complete a practice, for the "4-minute role-play" labels. */
function estimateMinutes(assessment) {
  const questions = (assessment.questions || []).length;
  if (['ROLEPLAY', 'VOICE'].includes(assessment.type)) return 5;
  if (assessment.type === 'PROCESS_SIM') return 4;
  const config = parse(assessment.configJson, {}) || {};
  if (config.estimatedMinutes) return config.estimatedMinutes;
  return Math.max(2, Math.min(15, Math.round(questions * 0.8) || 3));
}

const TYPE_TITLE = { QUIZ: 'quiz', ROLEPLAY: 'role-play', VOICE: 'voice practice', TECHNICAL: 'technical simulation', PROCESS_SIM: 'process simulation', PRODUCT_KNOWLEDGE: 'product exercise' };
const PRACTICAL = ['ROLEPLAY', 'VOICE', 'TECHNICAL', 'PROCESS_SIM'];
const startHref = (a) => (a.type === 'ROLEPLAY' ? `/assessments/${a.id}/roleplay` : `/assessments/${a.id}/take`);

function coversSkill(assessment, skillName) {
  const name = skillName.trim().toLowerCase();
  const config = parse(assessment.configJson, {}) || {};
  const listed = [...(config.rubricSkills || []), ...(config.focusSkills || [])].map((s) => String(s).toLowerCase());
  if (listed.includes(name)) return true;
  return (assessment.questions || []).some((q) => parse(q.skillIdsJson, []).some((s) => String(s).toLowerCase() === name));
}

async function loadLearning(profile) {
  const recipients = await prisma.trainingAssignmentRecipient.findMany({
    where: { profileId: profile.id, assignment: { organizationId: profile.organizationId, course: { status: 'PUBLISHED', archivedAt: null } } },
    include: {
      attempts: { select: { id: true, status: true, attemptNumber: true, score: true, assessmentId: true, completedAt: true } },
      assignment: { include: { course: { include: { assessments: { where: { status: 'APPROVED', archivedAt: null }, include: { questions: { select: { skillIdsJson: true } } } } } } } },
    },
  });
  return recipients.map((r) => {
    const latest = [...r.attempts].sort((a, b) => b.attemptNumber - a.attemptNumber)[0] || null;
    const course = r.assignment.course;
    const accessible = course.assessments.filter((a) => (!r.assignment.assessmentId || r.assignment.assessmentId === a.id) && (a.version === r.assignment.courseVersion || parse(a.configJson, {})?.targetedRetake === true) && !(parse(a.configJson, {})?.targetedRetake === true && a.createdById !== profile.id));
    return { recipient: r, course, assignment: r.assignment, status: latest ? latest.status : 'NOT_STARTED', latest, accessible };
  });
}

/**
 * Ranks what the employee should do next. Returns { items, next, summary }.
 * Priority bands: overdue 1000+, retake 900+, due soon 700+, assigned-not-started 400+, skill gaps 100-600, thin evidence < 100.
 */
async function nextActions(profile, { now = new Date() } = {}) {
  const [rows, learning, open, dueSoonDays] = await Promise.all([
    getSkillRows(profile, { now }),
    loadLearning(profile),
    prisma.developmentRecommendation.findMany({ where: { profileId: profile.id, status: 'OPEN' }, orderBy: { priority: 'desc' } }),
    getSetting(profile.organizationId, 'dev.dueSoonDays'),
  ]);
  const items = [];
  const push = (item) => items.push({ estimatedMinutes: null, action: null, skill: null, course: null, ...item });
  const accessibleAssessments = learning.flatMap((l) => l.accessible.map((a) => ({ a, l })));

  // ---- 1. required work: overdue, retakes, due soon, assigned but not started
  const isDone = (l) => l.status === 'COMPLETED';
  for (const l of learning) {
    const due = l.assignment.dueDate;
    const title = l.course.title;
    const courseAction = { type: 'OPEN', label: 'Open training', href: `/training-course/${l.course.id}` };
    if (l.status === 'RETAKE_REQUIRED' || l.status === 'FAILED') {
      const score = l.latest && l.latest.score !== null ? ` (last score ${Math.round(l.latest.score)}%)` : '';
      push({ kind: 'RETAKE', priority: 900 + (due && due < now ? 50 : 0), title: `Retake required: ${title}`, reason: `Your latest attempt${score} was below the passing score. A retake is required before this training counts as passed.`, course: { id: l.course.id, title }, action: { type: 'RETAKE', label: 'Start retake', href: `/training-course/${l.course.id}` } });
    } else if (due && due < now && !isDone(l)) {
      const days = Math.max(1, Math.round((now - due) / DAY_MS));
      push({ kind: 'OVERDUE', priority: 1000 + Math.min(days, 60), title: `Overdue: ${title}`, reason: `This was due ${days} day${days === 1 ? '' : 's'} ago and is not completed yet.`, course: { id: l.course.id, title }, action: courseAction });
    } else if (due && !isDone(l) && due - now <= dueSoonDays * DAY_MS) {
      push({ kind: 'DUE_SOON', priority: 700, title: `Due soon: ${title}`, reason: `Due ${due.toISOString().slice(0, 10)}.`, course: { id: l.course.id, title }, action: courseAction });
    } else if (l.status === 'IN_PROGRESS') {
      push({ kind: 'IN_PROGRESS', priority: 450, title: `Continue: ${title}`, reason: 'You started this training — pick up where you left off.', course: { id: l.course.id, title }, action: { type: 'OPEN', label: 'Continue training', href: `/training-course/${l.course.id}` } });
    } else if (l.status === 'NOT_STARTED') {
      push({ kind: 'ASSIGNED', priority: 400 + (l.course.mandatory ? 20 : 0), title: `Start: ${title}`, reason: `${l.course.mandatory ? 'Mandatory training' : 'Assigned training'} you have not started yet.${due ? ` Due ${due.toISOString().slice(0, 10)}.` : ''}`, course: { id: l.course.id, title }, action: { type: 'OPEN', label: 'Start training', href: `/training-course/${l.course.id}` } });
    }
  }

  // ---- 2. skill gaps (evidence-based) with the most relevant practice the employee can actually start
  const covered = new Set();
  for (const r of rows) {
    if (!r.assessed) continue;
    const declining = r.trend.direction === 'declining';
    const weak = r.score < 70;
    if (!weak && !declining) continue;
    const candidates = accessibleAssessments.filter(({ a }) => coversSkill(a, r.skill.name)).sort((x, y) => (PRACTICAL.includes(y.a.type) ? 1 : 0) - (PRACTICAL.includes(x.a.type) ? 1 : 0));
    const pick = candidates[0] || null;
    const kindText = Object.keys(r.kinds).length ? `Based on ${r.basis}.` : '';
    const trendText = declining ? ` It has dropped ${Math.abs(r.trend.delta)} points recently.` : r.trend.direction === 'improving' ? ` It is improving (+${r.trend.delta}).` : '';
    const confText = r.confidenceLevel === 'LOW' ? ' Evidence confidence is low, so one more practice will make this clearer.' : '';
    const severity = weak ? (70 - r.score) : Math.abs(r.trend.delta);
    const confFactor = { HIGH: 1.15, MEDIUM: 1, LOW: 0.7 }[r.confidenceLevel] || 0.7;
    const priority = Math.round(Math.min(600, 150 + severity * 6 * confFactor + (declining ? 40 : 0)));
    const practice = pick ? { assessmentId: pick.a.id, title: `${r.skill.name} ${TYPE_TITLE[pick.a.type] || 'practice'}`, minutes: estimateMinutes(pick.a) } : null;
    push({
      kind: declining && !weak ? 'DECLINING' : 'SKILL_GAP',
      priority,
      title: practice ? practice.title : `Improve ${r.skill.name}`,
      reason: `${r.skill.name} is ${r.score}% (${r.status.label}). ${kindText}${trendText}${confText}`.trim(),
      estimatedMinutes: practice ? practice.minutes : null,
      skill: { id: r.skill.id, name: r.skill.name, score: r.score, confidence: r.confidenceLevel },
      action: practice ? { type: 'START', label: 'Start practice', href: startHref(pick.a) } : { type: 'ASK', label: 'Ask your supervisor to assign practice', href: null },
    });
    covered.add(r.skill.id);
  }

  // ---- 3. thin evidence: skills that look fine but rest on very little
  for (const r of rows) {
    if (!r.assessed || covered.has(r.skill.id) || r.confidenceLevel !== 'LOW' || r.score < 70) continue;
    push({ kind: 'LOW_CONFIDENCE', priority: 60, title: `Confirm ${r.skill.name}`, reason: `${r.skill.name} shows ${r.score}%, but it rests on ${r.basis}. A practical exercise would confirm it.`, skill: { id: r.skill.id, name: r.skill.name, score: r.score, confidence: r.confidenceLevel }, action: { type: 'ASK', label: 'Ask your supervisor to assign practice', href: null } });
  }

  // ---- 4. rule / onboarding / retention recommendations that a person has not yet handled
  for (const rec of open) {
    const assessment = rec.assessmentId ? accessibleAssessments.find(({ a }) => a.id === rec.assessmentId) : null;
    const assigned = rec.courseId ? learning.find((l) => l.course.id === rec.courseId) : null;
    push({
      kind: rec.kind, priority: rec.priority, title: rec.title, reason: rec.reason, estimatedMinutes: rec.estimatedMinutes, recommendationId: rec.id,
      action: assessment ? { type: 'START', label: 'Start practice', href: startHref(assessment.a) } : assigned ? { type: 'OPEN', label: 'Open training', href: `/training-course/${assigned.course.id}` } : { type: 'ASK', label: 'Waiting for your supervisor to assign this', href: null },
    });
  }

  items.sort((a, b) => b.priority - a.priority);
  const summary = {
    required: learning.filter((l) => l.course.mandatory && !isDone(l)).length,
    current: learning.filter((l) => !isDone(l)).length,
    retakes: learning.filter((l) => l.status === 'RETAKE_REQUIRED' || l.status === 'FAILED').length,
    overdue: learning.filter((l) => l.assignment.dueDate && l.assignment.dueDate < now && !isDone(l)).length,
    completed: learning.filter(isDone).length,
  };
  return { items, next: items[0] || null, summary, rows, learning };
}

module.exports = { nextActions, estimateMinutes, coversSkill, loadLearning, startHref };
