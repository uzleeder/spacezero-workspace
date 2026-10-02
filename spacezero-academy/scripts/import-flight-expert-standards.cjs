'use strict';
// One-time CONTENT import for Company Standards & Workflow: the Flight Expert Responsibilities and the
// Flight Expert — CRM Search & Quote Workflow.
//
// Same mechanism as scripts/import-supervisor-standards.cjs (which holds the shared import logic): it
// writes ordinary rows into the EXISTING Standards tables, exactly what Settings → Standards (Admin UI)
// writes. Nothing here is read by the application at runtime; once imported, the text lives in the
// database and is edited, revised, versioned, published and archived from the Admin UI. It does not
// touch the CRM, the Expert queue, GDS configuration, permissions or any other content.
//
//   node scripts/import-flight-expert-standards.cjs                  # real run (DATABASE_URL decides which DB)
//   node scripts/import-flight-expert-standards.cjs --dry            # show what would happen, write nothing
//   node scripts/import-flight-expert-standards.cjs --email a@b.com  # which Admin is recorded as author/publisher
//
// Safe to run again: an item with the same type + title is UPDATED as a new published version (old one
// archived, history kept) only if its content differs; nothing is duplicated.
const { runCli, validate } = require('./import-supervisor-standards.cjs');

const AUDIENCE = ['FLIGHT_EXPERT'];
const SOURCE = 'import-flight-expert-standards';

// ---------------------------------------------------------------------------------------------
// DOCUMENT 1 — Flight Expert Responsibilities (type RESPONSIBILITY)
// An entry that starts with **a heading** is shown as a heading with its paragraph beneath.
// ---------------------------------------------------------------------------------------------
const RESPONSIBILITIES = {
  contentType: 'RESPONSIBILITY',
  title: 'Flight Expert Responsibilities',
  category: 'Flight Expert',
  audience: AUDIENCE,
  source: SOURCE,
  shortDescription: 'Defines the responsibilities of Flight Experts for GDS mastery, professional flight searching, fare and ticketing knowledge, product expertise, quote quality and continuous technical development.',
  requiredReading: true,
  items: [
    '**Core principle.** Learn → Practice → Search → Analyze → Verify → Improve → Share.',
    '**1. GDS mastery.** Continuously develop your Sabre/GDS skill and rely increasingly on professional GDS searching rather than consumer engines. Keep improving command knowledge, logic and speed. Accuracy always comes before speed.',
    '**2. Professional flight search.** Understand and compare routing, connections, airports, dates/flexibility, cabin, airlines, booking classes, schedule, journey duration, price and overall value.',
    '**3. Airline & airport codes.** Develop strong knowledge of frequently used airline and airport codes.',
    '**4. Fare construction.** Understand fare basis, booking class, routing, seasonality, advance purchase, minimum/maximum stay, stopovers, combinability where applicable, fare breaks and other pricing factors. Analyze WHY better fares exist and learn the patterns that may help future searches.',
    '**5. Fare rules.** Be able to retrieve and understand changes, refunds, penalties, validity, booking restrictions, routing restrictions, stopovers and exchanges/reissues. Verify before advising.',
    '**6. Ticketing, exchanges & reissues.** Maintain strong practical knowledge and avoid unverified technical advice.',
    '**7. Product knowledge.** Follow updates from Product Management and authorized Managers. For new products: study, test where appropriate, understand, practice, know the restrictions and understand why the product works.',
    '**8. Continuous practice.** Regularly practice GDS and search techniques to retain and improve your skill.',
    '**9. Search efficiency.** Become exceptionally fast and effective while preserving accuracy.',
    '**10. Client-preference thinking.** Search according to the client\'s actual needs: price, cabin, airline, stops, flexibility, convenience, schedule and value.',
    '**11. Option quality.** Provide meaningful alternatives, not three nearly identical flights.',
    '**12. Accuracy.** Double-check dates, route, passengers, cabin, airline, availability, fare and material restrictions.',
    '**13. Product Management communication.** The current primary senior Expert / Product Management escalation point is Tom Allen (an Admin can update this name here at any time). Other authorized Managers may assist where appropriate.',
    '**14. Difficult searches.** Escalate difficult cases after reasonable professional searching. Explain the requirements, the searches attempted, the available results, the problem and the assistance required.',
    '**15. Knowledge sharing.** Share useful techniques and discoveries appropriately.',
    '**16. Compliance.** Use legitimate, approved GDS and fare methods. Do not manipulate systems or misrepresent passenger or itinerary information.',
    '**Final principle:** Learn → Practice → Search → Analyze → Verify → Improve → Share.',
  ],
};

// ---------------------------------------------------------------------------------------------
// DOCUMENT 2 — Flight Expert — CRM Search & Quote Workflow (type WORKFLOW)
// ---------------------------------------------------------------------------------------------
const step = (title, instruction, extra = {}) => ({ title, instruction, ...extra });
const WORKFLOW = {
  contentType: 'WORKFLOW',
  title: 'Flight Expert — CRM Search & Quote Workflow',
  category: 'Flight Expert',
  audience: AUDIENCE,
  source: SOURCE,
  shortDescription: 'Defines how Flight Experts validate requests, work Expert queues, perform professional searches, provide meaningful options, handle revisions, escalate and hand over unfinished work.',
  requiredReading: false,
  steps: [
    step('Review the queue', 'Review the CRM Expert queue and the Agent\'s request.'),
    step('Validate information', 'Where applicable, verify:', { checklist: ['Origin / destination', 'Dates', 'Flexibility', 'Cabin', 'Airlines', 'Passengers', 'Stops', 'Booking readiness', 'Budget where available', 'Other client restrictions'] }),
    step('Review the Agent\'s basic search', 'The request should contain the applicable basic Agent searches and source notes according to the current Travel Agent workflow.', { explanation: 'If the Agent checked sources but found nothing, the CRM should state what was checked.' }),
    step('Incomplete request', 'If critical information is missing, return/refuse according to the existing workflow and clearly state what is needed.', { importantNote: 'Do not reject merely because optional information such as budget is unavailable when enough information exists to search.' }),
    step('Take the lead', 'Use the existing Take/assignment action. Do not alter its logic.'),
    step('Professional GDS search', 'Use approved professional systems and search intelligently around the client\'s requirements.'),
    step('Minimum three meaningful options', 'Where reasonably possible, provide at least THREE meaningful options.', { importantNote: 'Do not force three when viable alternatives genuinely do not exist.' }),
    step('Best overall match', 'Include a strong option that balances the client\'s preferences and value.'),
    step('Lower-cost alternative', 'Where meaningful, include a competitive cheaper option.', { explanation: 'Consider legitimate flexibility such as:', checklist: ['Dates', 'Airports', 'Airline', 'Routing', 'Stops'] }),
    step('Convenient option', 'Where relevant, include a convenient option even when it is more expensive.', { explanation: 'For example:', checklist: ['Nonstop', 'Shorter journey', 'Better schedule', 'Preferred airline', 'Better airport / connection'] }),
    step('Verify', 'Double-check the request and the results before completion.'),
    step('Complete', 'Use the existing CRM completion behavior.'),
    step('Revision', 'When a request returns for revision, review the NEW comment explaining why the previous options did not work.', { warning: 'Do not blindly repeat the same search.' }),
    step('Research according to the new feedback', 'Address the actual reason the client rejected the previous options.'),
    step('Escalate difficult cases', 'If no satisfactory solution exists after reasonable professional effort, escalate to the senior Expert / Product Management or an authorized Manager.'),
    step('End of shift', 'Review the following and complete what reasonably can be completed.', { checklist: ['Active leads', 'Unfinished searches', 'Revisions', 'Assigned Expert work'] }),
    step('Urgent unfinished work', 'If urgent work cannot be finished, ask authorized Management to assign/hand it over to the next available Expert.'),
    step('Handover', 'Provide:', { checklist: ['Requirements', 'Searches attempted', 'Useful results', 'Problems', 'Urgency', 'Suggested next direction'] }),
    step('Workflow summary', 'Review Request → Validate Information → Take Lead → Search → Compare → Add Options → Verify → Complete → Revise → Escalate / Handover'),
    step('Quality principle', 'The Expert\'s job is not simply "Add three flights." It is:', { checklist: ['Understand', '+ Professional Search', '+ Meaningful Comparison', '+ Accurate Options', '+ Commercial Value'] }),
  ],
};

const DOCUMENTS = [RESPONSIBILITIES, WORKFLOW];
for (const doc of DOCUMENTS) validate(doc);

module.exports = { DOCUMENTS };

if (require.main === module) runCli(DOCUMENTS);
