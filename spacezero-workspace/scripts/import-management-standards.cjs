'use strict';
// One-time CONTENT import for Company Standards & Workflow: the Management Responsibilities and the
// Management — Team Oversight & Operational Support Workflow.
//
// SpaceZero uses the Admin role for Management and the Standards audience list has no separate
// Management audience (TRAVEL_AGENT, FLIGHT_EXPERT, SUPERVISOR, ADMIN), so both documents use the
// existing Admin audience. No role is created. Same mechanism as scripts/import-supervisor-standards.cjs
// (which holds the shared import logic): ordinary rows in the EXISTING Standards tables, exactly what
// Settings → Standards (Admin UI) writes. Nothing here is read by the application at runtime; once
// imported, the text lives in the database and is edited, revised, versioned, published and archived
// from the Admin UI. It does not touch roles, Admin/Supervisor permissions, payroll or compensation
// logic, equipment tracking, Training, Setup or any other content. No Manager names are hard-coded.
//
//   node scripts/import-management-standards.cjs                  # real run (DATABASE_URL decides which DB)
//   node scripts/import-management-standards.cjs --dry            # show what would happen, write nothing
//   node scripts/import-management-standards.cjs --email a@b.com  # which Admin is recorded as author/publisher
//
// Safe to run again: an item with the same type + title is UPDATED as a new published version (old one
// archived, history kept) only if its content differs; nothing is duplicated.
const { runCli, validate } = require('./import-supervisor-standards.cjs');

const AUDIENCE = ['ADMIN'];
const SOURCE = 'import-management-standards';

// ---------------------------------------------------------------------------------------------
// DOCUMENT 1 — Management Responsibilities (type RESPONSIBILITY)
// An entry that starts with **a heading** is shown as a heading with its paragraph beneath.
// ---------------------------------------------------------------------------------------------
const RESPONSIBILITIES = {
  contentType: 'RESPONSIBILITY',
  title: 'Management Responsibilities',
  category: 'Management',
  audience: AUDIENCE,
  source: SOURCE,
  shortDescription: 'Defines Management responsibilities for organizational oversight, Supervisor and Expert development, employee support, operational standards, workplace environment, training, business continuity and company resources.',
  requiredReading: true,
  items: [
    '**Introduction.** Management is responsible for maintaining a professional, supportive and effective working environment, and for making sure teams, Supervisors and Flight Experts have the information, training, resources and guidance they need to succeed. Management leads through: **Observe → Support → Develop → Verify → Improve.**',
    '**1. Organizational oversight.** Keep overall awareness of company operations and work closely with Supervisors so teams function effectively. Monitor employee performance, Supervisor effectiveness, Flight Expert development, training needs, operational issues, recurring workflow problems, client-service quality, company standards and overall office readiness.',
    '**2. Supervisor support.** Communicate regularly with Supervisors and give them the guidance to manage and develop their teams. Help them address performance problems, improve coaching, identify training needs, handle difficult operational situations, understand new company products and procedures, and improve team standards.',
    '**3. Flight Expert development.** Flight Experts are a key technical resource. Make sure they receive product updates, GDS development, fare and ticketing knowledge, advanced search guidance, new product information, practical training and opportunities to improve their technical ability. The appropriate Product/Expert leadership should actively help Experts keep developing.',
    '**4. Product & company updates.** Make sure important company and product updates reach the right employees: Supervisors understand the update, Flight Experts understand technical/product changes, Agents receive what is relevant to their work, necessary training is provided and outdated information is corrected. Important operational information should not remain only with Management.',
    '**5. Training & development.** Actively support employee development. Managers may conduct training, join Supervisor training sessions, coach Supervisors and Flight Experts, help Agents improve sales/communication skills, give product training, suggest topics, help create material and identify recurring company-wide knowledge gaps. Training should respond to real operational needs.',
    '**6. Professional workplace environment.** Maintain a professional, respectful and positive office. Treat employees fairly and respectfully, and encourage professional communication, teamwork, reasonable support, respectful conduct, constructive feedback and continuous development. The aim is a workplace that is both professional and comfortable for employees.',
    '**7. Employee support & compensation administration.** Make sure employee compensation and other agreed employment arrangements are administered accurately and on time, according to the applicable agreements, approved company procedures and relevant requirements. Handle employment or compensation concerns professionally and through the appropriate Management process.',
    '**8. Company standards & workflow oversight.** Make sure the Company Standards, Responsibilities, operational Workflows, product requirements and client-service procedures are understood and followed. Check that procedures stay practical and effective, and when improvement is needed update the authoritative content rather than relying only on informal instructions.',
    '**9. Consultant / Agent workflow quality.** Pay particular attention to how Travel Agents handle clients and whether the approved sales, CRM, follow-up and servicing workflows are followed. Where recurring problems appear, work with Supervisors to find the cause and improve the process or the training.',
    '**10. Management availability.** Stay reasonably reachable for significant operational questions and escalations — urgent ticketing situations, difficult client cases, Supervisor questions, Flight Expert escalation, product uncertainty and important operational decisions. This does not mean every minor issue goes straight to Management: normal role and Supervisor escalation paths still apply.',
    '**11. Equipment & working resources.** Make sure employees have the working resources their roles need: computers, monitors, headsets, phones, internet/network access, required company systems and other necessary equipment. When important equipment fails or becomes unsuitable, arrange repair, replacement or another reasonable solution.',
    '**12. Continuous improvement.** Look for reasonable opportunities to improve employee development, training, products, processes, systems, client service, operational efficiency and workplace quality. Consider useful feedback from Supervisors, Flight Experts and Travel Agents.',
    '**Management responsibility principle.** Management should not operate only by reacting when something goes wrong. The expected principle: **Observe → Communicate → Support → Develop → Verify → Improve.**',
  ],
};

// ---------------------------------------------------------------------------------------------
// DOCUMENT 2 — Management — Team Oversight & Operational Support Workflow (type WORKFLOW)
// ---------------------------------------------------------------------------------------------
const step = (title, instruction, extra = {}) => ({ title, instruction, ...extra });
const WORKFLOW = {
  contentType: 'WORKFLOW',
  title: 'Management — Team Oversight & Operational Support Workflow',
  category: 'Management',
  audience: AUDIENCE,
  source: SOURCE,
  shortDescription: 'Defines the practical Management workflow for organizational oversight, Supervisor support, product communication, training, operational escalation, employee resources and continuous improvement.',
  requiredReading: false,
  steps: [
    step('Review important operations', 'Maintain awareness of important matters requiring Management attention.', { explanation: 'Examples:', checklist: ['Significant employee issue', 'Supervisor escalation', 'Flight Expert escalation', 'Urgent client matter', 'Major technical problem', 'Important training requirement', 'Operational risk'] }),
    step('Communicate with Supervisors', 'Maintain regular communication with Supervisors regarding:', { checklist: ['Team performance', 'Employee problems', 'Training', 'Attendance concerns', 'Recurring workflow issues', 'Operational difficulties', 'Improvement opportunities'] }),
    step('Support Flight Experts', 'Ensure Flight Experts receive relevant technical/product support.', { explanation: 'Where appropriate:', checklist: ['Provide product updates', 'Discuss difficult searches', 'Teach advanced concepts', 'Review new products', 'Encourage testing/practice', 'Help identify reusable knowledge'] }),
    step('Distribute important updates', 'When a new product, process or important company update is introduced, determine WHO needs to know and communicate the information through the appropriate channel. Where necessary, follow the update with training.'),
    step('Monitor training needs', 'Use feedback to identify training opportunities.', { explanation: 'Sources:', checklist: ['Supervisors', 'Flight Experts', 'Agent performance', 'Operational problems', 'Recurring mistakes'] }),
    step('Support training', 'When useful, Management may:', { checklist: ['Train employees directly', 'Train Supervisors', 'Train Experts', 'Help Supervisors prepare training', 'Participate in team sessions', 'Provide examples/material', 'Review whether the training solved the problem'] }),
    step('Monitor workflow quality', 'Review whether important workflows are actually being followed.', { explanation: 'Pay particular attention to:', checklist: ['Client handling', 'CRM', 'Follow-up', 'Expert workflow', 'Ticketing/product disclosure', 'Servicing', 'Handovers'], importantNote: 'If a recurring workflow problem exists, determine whether the cause is an unclear process, lack of training, a technical problem, poor execution or an outdated standard — then address the appropriate cause.' }),
    step('Handle escalations', 'When a significant issue is escalated: Review the facts → Verify relevant rules/information → Provide direction → Assign ownership → Follow up if necessary.'),
    step('Workplace & employee support', 'Maintain a professional and respectful office environment. Address significant employee concerns appropriately. Ensure important employment/compensation administration is processed according to approved agreements and company procedure.'),
    step('Check working resources', 'When a material equipment/system problem affects an employee\'s ability to work, arrange appropriate:', { checklist: ['Technical support', 'Repair', 'Replacement', 'Alternative working solution'], importantNote: 'Do not leave important work equipment problems unresolved unnecessarily.' }),
    step('Follow up', 'After significant coaching, training, operational correction, technical resolution or employee issue, verify that the problem was actually resolved.'),
    step('Continuous improvement', 'When Management identifies a useful improvement, discuss it with the relevant people. If approved, update the appropriate authoritative content through the existing SpaceZero systems:', { checklist: ['Standard', 'Responsibility', 'Workflow', 'Training', 'Configuration'], warning: 'Do not rely permanently on undocumented verbal rules.' }),
    step('Daily / regular management flow', 'Review → Communicate → Support → Resolve → Develop → Follow Up'),
    step('Workflow principle', 'Management should create clarity and continuity. The operational cycle is: Review → Communicate → Support → Resolve → Develop → Follow Up → Improve.'),
  ],
};

const DOCUMENTS = [RESPONSIBILITIES, WORKFLOW];
for (const doc of DOCUMENTS) validate(doc);

module.exports = { DOCUMENTS };

if (require.main === module) runCli(DOCUMENTS);
