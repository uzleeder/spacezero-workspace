'use strict';

// The training page goes through a training ONE step at a time: every piece of material in order, then every practice
// or quiz, then "Training complete". stepsOf() is the only place that order (and where the learner is) is decided.
// Learners can go back to anything before their current step but not past it - the step they have not finished yet;
// someone previewing the training (an Admin, the supervisor who made it) can open any step.
// Pure: the route loads the material, the practices and what the learner has done, and passes them in.
const { MEDIA_TYPES } = require('./mediaProgress');

const KIND_OF_MODULE = { VIDEO: 'video', AUDIO: 'audio', CALL_RECORDING: 'audio', NOTE: 'note', LINK: 'link' };
const PRACTICE_LABEL = { QUIZ: 'Quiz', ROLEPLAY: 'Role-play', VOICE: 'Voice practice' };

function materialKind(module) {
  if (MEDIA_TYPES.includes(module.contentType)) return module.storagePath ? KIND_OF_MODULE[module.contentType] : 'missing';
  if (module.contentType === 'NOTE') return 'note';
  if (module.contentType === 'LINK') return /^https?:\/\//i.test(module.externalUrl || '') ? 'link' : 'missing';
  return module.storagePath ? 'document' : 'missing';
}

/**
 * { modules, assessments, isLearner, doneIds, requiredIds, passedIds } -> { steps, current }
 * steps[i] = { number, kind, title, module | assessment, required, done, blocking, open }; the last is the finish step.
 * current = the step the learner is on: the first required item or practice not finished yet, else the finish step
 * (the first step for a preview).
 */
function stepsOf({ modules, assessments, isLearner, doneIds = new Set(), requiredIds = new Set(), passedIds = new Set() }) {
  const steps = [
    ...modules.map((module) => {
      const required = requiredIds.has(module.id);
      const done = doneIds.has(module.id);
      return { kind: materialKind(module), title: module.title, module, required, done, blocking: isLearner && required && !done };
    }),
    ...assessments.map((assessment) => {
      const done = passedIds.has(assessment.id);
      return { kind: 'practice', label: PRACTICE_LABEL[assessment.type] || 'Practice', title: assessment.title, assessment, required: true, done, blocking: isLearner && !done };
    }),
    { kind: 'finish', title: 'Training complete', required: false, done: false, blocking: false },
  ].map((step, i) => ({ ...step, number: i + 1 }));
  const firstBlocking = steps.findIndex((s) => s.blocking);
  // a preview starts at the beginning; a learner where they are
  const current = !isLearner ? 0 : firstBlocking >= 0 ? firstBlocking : steps.length - 1;
  steps.forEach((s, i) => { s.open = !isLearner || i <= current; });
  return { steps, current };
}

/** The step to show for ?step=N (1-based): the one asked for when it is open, else the learner's current step. */
function stepToShow({ steps, current }, requested) {
  const n = Number.parseInt(requested, 10);
  return Number.isInteger(n) && n >= 1 && n <= steps.length && steps[n - 1].open ? n - 1 : current;
}

module.exports = { stepsOf, stepToShow, materialKind };
