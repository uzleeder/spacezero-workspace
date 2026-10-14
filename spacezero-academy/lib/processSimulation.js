'use strict';
const { z } = require('zod');
const { prisma } = require('./prisma');
const { generateStructured } = require('./gemini');
const { shuffleChoices } = require('./shuffleOptions');
const schema = z.object({ startId: z.string(), skills: z.array(z.string()).min(1).max(6), nodes: z.array(z.object({ id: z.string(), situation: z.string().min(1), options: z.array(z.object({ label: z.string().min(1), nextId: z.string().nullable(), score: z.number().min(0).max(100), feedback: z.string() })).min(2).max(4) })).min(3).max(15) });
const responseSchema = { type: 'OBJECT', properties: { startId: { type: 'STRING' }, skills: { type: 'ARRAY', items: { type: 'STRING' } }, nodes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, situation: { type: 'STRING' }, options: { type: 'ARRAY', items: { type: 'OBJECT', properties: { label: { type: 'STRING' }, nextId: { type: 'STRING', nullable: true }, score: { type: 'NUMBER' }, feedback: { type: 'STRING' } }, required: ['label','nextId','score','feedback'] } } }, required: ['id','situation','options'] } } }, required: ['startId','skills','nodes'] };
function validateGraph(config) {
  const parsed = schema.parse(config), nodes = new Map(parsed.nodes.map(n => [n.id, n]));
  if (nodes.size !== parsed.nodes.length) throw new Error('Duplicate scenario node.');
  function walk(id, visited) {
    if (!nodes.has(id) || visited.has(id) || visited.size > 8) throw new Error('Invalid or cyclic scenario path.');
    for (const o of nodes.get(id).options) if (o.nextId !== null) walk(o.nextId, new Set([...visited, id]));
  }
  walk(parsed.startId, new Set());
  return parsed;
}
async function generateProcessAssessment({ course, analysis, actor, level = 3, focusSkills = null, status = 'AI_GENERATED' }) {
  const result = await generateStructured({ systemInstruction: 'Create a branching SOP/workflow simulation grounded exclusively in the supplied training facts. Each decision changes the next situation. Include mistakes and consequences. EVERY node — including the last ones — must offer 2 to 4 options: on a final node, the options are the closing choices the learner can make and each has nextId null. Never give a node a single option. Return a finite acyclic graph, 3–15 nodes, maximum path length 8. Options have score 0–100 and evidence-based feedback. nextId null ends the simulation. Do not invent company rules.', contents: [{ role: 'user', parts: [{ text: `Level ${level}. Facts: ${analysis.criticalKnowledgeJson}\nBehaviors: ${analysis.practicalBehaviorsJson}\nSkills: ${JSON.stringify(focusSkills || JSON.parse(analysis.extractedSkillsJson || '[]'))}` }] }], responseSchema, zodSchema: schema });
  const config = validateGraph(result.data);
  // The AI lists the best action first; stir each step's choices (nextId travels with each choice, so the flow is unchanged).
  config.nodes = config.nodes.map((n) => ({ ...n, options: shuffleChoices(n.options) }));
  return prisma.assessment.create({ data: { organizationId: course.organizationId, courseId: course.id, createdById: actor.id, createdVia: 'AI_TRAINING_ANALYSIS', type: 'PROCESS_SIM', title: `${course.title} — Workflow simulation`, level, passingScore: course.passingScore, status, configJson: JSON.stringify({ ...config, ...(focusSkills?.length ? { targetedRetake: true, focusSkills } : {}) }), modelVersion: result.modelVersion } });
}
module.exports = { generateProcessAssessment, validateGraph };
