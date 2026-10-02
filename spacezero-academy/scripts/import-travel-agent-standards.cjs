'use strict';
// One-time CONTENT import for Company Standards & Workflow: the Travel Agent Responsibilities and the
// Travel Agent — Client Handling, CRM & Sales Workflow.
//
// Same mechanism as scripts/import-supervisor-standards.cjs (which holds the shared import logic): it
// writes ordinary rows into the EXISTING Standards tables, exactly what Settings → Standards (Admin UI)
// writes. Nothing here is read by the application at runtime; once imported, the text lives in the
// database and is edited, revised, versioned, published and archived from the Admin UI. It does not
// touch the CRM, CRM statuses, UMS, the Expert queue, G-Chat, ticketing, pricing/margin logic, Award
// configuration, permissions or any other content.
//
//   node scripts/import-travel-agent-standards.cjs                  # real run (DATABASE_URL decides which DB)
//   node scripts/import-travel-agent-standards.cjs --dry            # show what would happen, write nothing
//   node scripts/import-travel-agent-standards.cjs --email a@b.com  # which Admin is recorded as author/publisher
//
// Safe to run again: an item with the same type + title is UPDATED as a new published version (old one
// archived, history kept) only if its content differs; nothing is duplicated.
const { runCli, validate } = require('./import-supervisor-standards.cjs');

const AUDIENCE = ['TRAVEL_AGENT'];
const SOURCE = 'import-travel-agent-standards';

// ---------------------------------------------------------------------------------------------
// DOCUMENT 1 — Travel Agent Responsibilities (type RESPONSIBILITY)
// An entry that starts with **a heading** is shown as a heading with its paragraph beneath.
// ---------------------------------------------------------------------------------------------
const RESPONSIBILITIES = {
  contentType: 'RESPONSIBILITY',
  title: 'Travel Agent Responsibilities',
  category: 'Travel Agent',
  audience: AUDIENCE,
  source: SOURCE,
  shortDescription: 'Defines the responsibilities of Travel Agents for professional client service, consultation, sales development, communication, follow-up, CRM discipline, product knowledge and continuous improvement.',
  requiredReading: true,
  items: [
    '**Core principle.** The Travel Agent is not simply a flight searcher. The Travel Agent is a Travel Consultant: **Listen → Understand → Analyze → Advise → Follow Up → Support → Retain.**',
    '**1. Industry & product knowledge.** Develop your understanding of airlines, routes, cabin classes, schedules, stops, fares, ticket conditions, changes/refunds, baggage/benefits, company products and basic GDS concepts.',
    '**2. Professional communication.** Know how to open conversations, perform discovery, listen, explain clearly, communicate confidently, present value, remain professional and establish next steps.',
    '**3. Sales development.** Continuously improve first-call performance, discovery, objection handling, value presentation, closing, follow-up and client retention. Review your own calls and learn from strong Agents and from Supervisor coaching.',
    '**4. First-call quality.** Use the first call to understand the client, build trust, identify flexibility, understand priorities, establish urgency and create a clear next action.',
    '**5. Travel consultant mindset.** Do not think only "What flight can I find?" Think: "What solution is most likely to work for this client?"',
    '**6. Company standards & ethics.** Follow the Company Standards, your role responsibilities, the approved workflows, truthful communication, confidentiality and professional conduct.',
    '**7. Supervisor communication.** Your assigned Supervisor is normally the first management contact. Communicate important difficult cases, training needs, product uncertainty, technical problems, workflow questions, complaints and operational issues.',
    '**8. Verify important rules.** Dynamic or important matters — fare rules, changes, penalties, refunds, special products and unusual conditions — must be verified. Use the appropriate Supervisor, Flight Expert, Product/Ticketing specialist or authorized Manager.',
    '**9. Shift responsibility.** Respect your assigned working schedule. If you know you will be late or unable to attend, inform the appropriate Supervisor as soon as reasonably possible.',
    '**10. Absence.** Planned absence should be discussed in advance where reasonably possible. For medical absence, follow the approved company requirements regarding appropriate medical documentation. Report unexpected illness or an emergency as soon as reasonably possible.',
    '**11. Vacation.** Use Profile & Settings → Vacation & Leave. For planned vacations, a request approximately THREE MONTHS in advance is preferred where reasonably possible. Approval remains subject to the existing company process.',
    '**12. Client responsibility.** Do not unnecessarily leave assigned clients without support. If you cannot continue, inform your Supervisor and make sure important client needs are handed over.',
    '**13. Customer service.** Clients should receive respect, patience, honesty, responsiveness, professionalism and attention.',
    '**14. Commercial responsibility.** Do not knowingly make unauthorized negative-margin sales. Follow the approved pricing/margin guidance and verify if you are uncertain.',
    '**15. CRM discipline.** Keep accurate lead status, comments, preferences, follow-up, appointments and pending actions.',
    '**16. Follow-up.** Follow-up is a core responsibility. When a sale does not close, create a clear next action. If you promise a callback time, make every reasonable effort to keep that promise.',
    '**17. UMS.** Understand and monitor the United Messaging System. Depending on the current configuration this may include SMS, WhatsApp, inbound email visibility and web/checkout messages. Maintain the applicable notifications.',
    '**18. Professional writing.** Emails and messages should remain clear, organized, polite, understandable and professional.',
    '**19. Difficult clients.** Never answer abusive communication with the same behavior; remain professional. Warn, escalate or end the conversation according to the approved process when required.',
    '**20. Accurate product disclosure.** Never intentionally hide material restrictions, misrepresent the cabin, the itinerary or the product, or promise unavailable benefits.',
    '**21. After-sales service.** Assist appropriately with seats, frequent-flyer details, KTN, traveler information, wheelchair/special requests, schedule changes, changes/modifications and applicable check-in support.',
    '**22. Visa / passport boundary.** Do not guarantee visa eligibility, entry eligibility, passport compliance or immigration requirements. Clients should verify these with the official authorities.',
    '**23. Schedule changes.** Ensure affected clients are appropriately informed.',
    '**24. Check-in.** Revenue tickets: check-in assistance is recommended where practical. Applicable Award/company-managed products: follow the required company/ticketing process to obtain and provide boarding passes during the appropriate check-in window.',
    '**25. Client retention.** After good service, you may appropriately ask for feedback, request honest reviews, invite referrals and maintain professional client relationships.',
    '**26. Continuous improvement.** Improve your sales, listening, communication, product knowledge, CRM, follow-up, client analysis and confidence.',
    '**Final principle:** Listen → Understand → Analyze → Advise → Follow Up → Support → Retain.',
  ],
};

// ---------------------------------------------------------------------------------------------
// DOCUMENT 2 — Travel Agent — Client Handling, CRM & Sales Workflow (type WORKFLOW)
// ---------------------------------------------------------------------------------------------
const step = (title, instruction, extra = {}) => ({ title, instruction, ...extra });
const WORKFLOW = {
  contentType: 'WORKFLOW',
  title: 'Travel Agent — Client Handling, CRM & Sales Workflow',
  category: 'Travel Agent',
  audience: AUDIENCE,
  source: SOURCE,
  shortDescription: 'Defines the operational process for handling leads, first calls, CRM updates, Expert requests, follow-up, UMS communication, sales, disclosure, servicing and retention.',
  requiredReading: false,
  steps: [
    step('Receive & review the lead', 'Review the lead before you contact the client:', { checklist: ['Destination', 'Origin', 'Dates', 'Client contact', 'Existing notes', 'Previous communication'] }),
    step('First contact', 'Communicate professionally. Understand the request before reducing the conversation to price.'),
    step('Discovery', 'Where applicable, collect:', { checklist: ['Flexibility', 'Cabin', 'Airline preferences', 'Passenger count', 'Maximum stops', 'How soon they can book', 'Budget where available', 'Airport preference', 'Schedule preference', 'Other material requirements'] }),
    step('CRM status', 'Every active lead must have an appropriate existing CRM status.', { importantNote: 'Use only the statuses currently configured by the CRM. Do NOT create new statuses from this workflow.' }),
    step('CRM comments', 'Record useful:', { checklist: ['Preferences', 'Discussion', 'Searches', 'Follow-up', 'Objections', 'Appointments', 'Expert request', 'Next action'] }),
    step('Rush / client on the line', 'When urgent Expert assistance is required while the client is waiting, use the approved Expert Chat (Rush / On the Line) or the current equivalent.', { checklist: ['Tag the Expert', 'Tag the Supervisor', 'Provide sufficient preferences'] }),
    step('Normal Expert queue', 'For non-rush cases, use the CRM Expert queue according to the current process.'),
    step('Basic Agent search', 'Before a normal Expert queue submission, perform the required basic company-approved search. Record useful source information in the CRM.', { explanation: 'Current examples may include:', checklist: ['OAG', 'Cockpit', 'AGF', 'Other approved tools'] }),
    step('If nothing is found', 'Document what was checked.', { explanation: 'Example: "Checked Cockpit and OAG — no suitable option found."' }),
    step('Send to Expert', 'Provide complete preferences and the basic search context.', { importantNote: 'The Agent remains responsible for the client relationship.' }),
    step('Review Expert options', 'Do not blindly forward options.', { explanation: 'Understand:', checklist: ['Best fit', 'Pricing', 'Convenience', 'Routing', 'Restrictions', 'Value'] }),
    step('Present a solution', 'Explain the options as a Consultant.', { explanation: 'Where relevant, compare:', checklist: ['Best overall', 'Lower-cost', 'Most convenient', 'Airline preference', 'Schedule', 'Nonstop / connection trade-off'] }),
    step('If the sale does not close', 'Create a clear next action. Preferably establish a callback/appointment.'),
    step('Keep callback promises', 'If a specific callback time is promised, call at the promised time where reasonably possible. If delayed, inform the client rather than disappearing.'),
    step('International follow-up', 'For applicable international leads that are not closed or opted out, the minimum follow-up period is FOUR DAYS, unless the lead status/process indicates otherwise.'),
    step('Follow-up standard', 'Current general sales standard during applicable follow-up:', { explanation: 'Current practice may include two ring attempts where appropriate. Respect client opt-outs, applicable communication requirements and professional boundaries.', checklist: ['At least one email per day', 'Approximately 2–3 call attempts at reasonable, different times'], importantNote: 'The purpose is persistent professional follow-up, not harassment.' }),
    step('Update the CRM after actions', 'After meaningful activity, update:', { checklist: ['Status', 'Comments', 'Contact result', 'Next action'] }),
    step('UMS', 'Monitor UMS appropriately and respond according to the current system functionality.', { explanation: 'UMS may contain:', checklist: ['SMS', 'WhatsApp', 'Inbound emails', 'Web/checkout messages'] }),
    step('Email', 'If outgoing email cannot be sent through UMS, use the approved company email system.'),
    step('Before the sale', 'Verify:', { checklist: ['Passenger details', 'Dates', 'Routing', 'Cabin', 'Price', 'Product', 'Material restrictions'] }),
    step('Product type', 'Identify whether the approved product is:', { checklist: ['Award', 'Revenue / private fare', 'Other authorized product'] }),
    step('Award disclosure', 'For applicable approved Award products, clearly explain the current required disclosures. Use the current Product Management rules.', { explanation: 'These may include:', checklist: ['Applicable cabin/service benefits', 'Mileage/points accumulation restrictions', 'Company-managed servicing', 'Change procedures', 'Other approved Award conditions'], warning: 'Do not invent restrictions.' }),
    step('Revenue / private fare', 'Explain the material conditions of:', { checklist: ['Published fares', 'Private fares', 'Contracted fares', 'Negotiated fares', 'Other approved revenue products'] }),
    step('Special itinerary disclosure', 'If discounted/special products include unusual or additional segments, disclose these clearly.', { importantNote: 'The booked itinerary must materially match what the client accepted.' }),
    step('Margin check', 'Follow the approved pricing/margin requirements. If uncertain, verify before the sale.'),
    step('After-sales', 'Assist appropriately with:', { checklist: ['Seat assignment', 'FF number', 'KTN', 'Global Entry / traveler data where applicable', 'Wheelchair', 'Permitted special requests'] }),
    step('Modification', 'Before advising a change, verify the applicable rules.', { explanation: 'Clearly explain where applicable:', checklist: ['Penalty', 'Fare difference', 'Taxes/fees', 'Restrictions'] }),
    step('Visa / document questions', 'Do not provide unsupported guarantees. Refer clients to the relevant official authorities.'),
    step('Difficult client', 'Remain professional. Do not mirror abusive behavior. Escalate/end the conversation according to the company process where required.'),
    step('Schedule change', 'Inform the affected client, or ensure another authorized person takes ownership.'),
    step('Revenue check-in', 'You may assist as an additional service where practical.'),
    step('Award / company-managed check-in', 'For applicable products requiring company handling, coordinate with ticketing when check-in opens and ensure boarding-pass delivery is handled. If you are unable to do it personally, hand over the responsibility.'),
    step('Reviews & referrals', 'After successful service, appropriately request feedback, an honest review and referrals.', { warning: 'Never condition service on a positive review.' }),
    step('Final CRM update', 'Ensure the CRM accurately reflects:', { checklist: ['Outcome', 'Status', 'Next action', 'Servicing', 'Follow-up'] }),
    step('Core flow', 'Receive → Review → Contact → Discover → Record → Search / Expert Support → Present Solution → Next Action → Follow Up → Close → Disclose → Service → Retain'),
    step('Golden rule', 'The Agent is not: Search → Quote → Wait. The professional cycle is: Listen → Understand → Analyze → Advise → Follow Up → Support → Retain.'),
  ],
};

const DOCUMENTS = [RESPONSIBILITIES, WORKFLOW];
for (const doc of DOCUMENTS) validate(doc);

module.exports = { DOCUMENTS };

if (require.main === module) runCli(DOCUMENTS);
