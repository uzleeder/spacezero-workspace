'use strict';
// One-time CONTENT import for Company Standards & Workflow → Company Standards: the
// "SpaceZero General Company & Workplace Standard" (one authoritative company-wide Standard).
//
// Same mechanism as scripts/import-supervisor-standards.cjs (which holds the shared import logic): an
// ordinary StandardsItem + StandardsVersion with structured Heading / Paragraph blocks — exactly what
// Settings → Standards (Admin UI) writes. Nothing here is read by the application at runtime; once
// imported, the text lives in the database and is edited, revised, versioned, published and archived
// from the Admin UI. It does not touch roles, permissions, Responsibilities, Workflows, Training or
// any other content, and it creates no legal, payroll or disciplinary policy.
//
// If a Standard with this exact title already exists it is UPDATED (a new published version; the old
// one is archived and kept as history) only when its content or flags differ — never duplicated. An
// existing "acknowledgement required" setting is kept, and nobody is acknowledged automatically.
//
//   node scripts/import-general-company-standard.cjs                  # real run (DATABASE_URL decides which DB)
//   node scripts/import-general-company-standard.cjs --dry            # show what would happen, write nothing
//   node scripts/import-general-company-standard.cjs --email a@b.com  # which Admin is recorded as author/publisher
const { runCli, validate } = require('./import-supervisor-standards.cjs');

const section = (heading, paragraph) => [{ type: 'heading', text: heading }, { type: 'paragraph', text: paragraph }];

const STANDARD = {
  contentType: 'STANDARD',
  title: 'SpaceZero General Company & Workplace Standard',
  category: 'General Company Standard',
  audience: null, // Everyone
  source: 'import-general-company-standard',
  shortDescription: 'Defines the general professional, workplace, confidentiality, service and conduct expectations for everyone working at SpaceZero.',
  requiredReading: true,
  important: true, // Featured
  quickReference: false,
  blocks: [
    { type: 'paragraph', text: 'This standard defines the general professional, workplace, confidentiality, service, security and conduct expectations that apply to everyone working at SpaceZero. Role-specific responsibilities and operational workflows are maintained separately.' },
    ...section('1. Professional Conduct', 'Every employee is expected to act professionally, respectfully and responsibly during working hours and when representing SpaceZero. Communication with colleagues, supervisors, clients, partners and suppliers must remain appropriate, respectful and professional.'),
    ...section('2. Attendance & Working Responsibilities', 'Employees are expected to follow their assigned work schedule, arrive on time and be ready to perform their responsibilities at the beginning of their shift. Delays, absences or situations affecting attendance should be communicated to the appropriate Supervisor or Manager as early as reasonably possible and handled according to the applicable leave and attendance process.'),
    ...section('3. Client Service & Professional Accuracy', 'Employees working with clients are expected to provide clear, accurate and responsible service. Information regarding travel, pricing, availability, airline rules, booking conditions and other services should be based on verified information available through approved company systems and sources. Employees must not knowingly misrepresent material information to a client.'),
    ...section('4. Confidentiality & Information Protection', 'Client information, employee information, company information, commercial information, internal processes, credentials and other confidential information must be protected. Employees may access or use information only when required for their authorized work and must not share confidential information with unauthorized persons.'),
    ...section('5. Company Systems, Accounts & Equipment', 'Company systems, accounts, communication tools, devices and access credentials must be used responsibly and for authorized business purposes. Passwords and protected access information must not be shared unless specifically authorized. Suspected unauthorized access, lost credentials or security incidents must be reported promptly.'),
    ...section('6. Workplace Standards', 'Employees are expected to contribute to a clean, professional and respectful workplace. Company property and equipment must be treated responsibly. Conduct that seriously disrupts the workplace, interferes with colleagues\' ability to work or damages the professional environment is not acceptable.'),
    ...section('7. Training & Professional Development', 'Employees are expected to complete required training, assessments, setup requirements, certifications and development activities applicable to their role. Employees should maintain the knowledge necessary to perform their responsibilities and follow current approved company procedures.'),
    ...section('8. Following Approved Responsibilities & Workflows', 'Employees are expected to follow the responsibilities, standards and workflows applicable to their role. When a procedure is unclear, the employee should seek guidance from the appropriate Supervisor or Manager rather than making assumptions that could create unnecessary risk for a client, colleague or the company.'),
    ...section('9. Reporting & Escalation', 'Significant mistakes, client complaints, operational problems, security concerns and other material risks should be reported promptly through the appropriate management or escalation process. Employees are expected to cooperate in resolving issues and must not intentionally conceal material errors or incidents.'),
    ...section('10. Professional Representation of SpaceZero', 'Employees should act professionally when dealing with business partners, travel providers, airlines, suppliers and other third parties. Conduct when representing the company should support professional and reliable business relationships.'),
    ...section('11. Acknowledgement', 'All employees are expected to read, understand and follow this standard together with any applicable role responsibilities, workflows, security requirements and other approved company instructions.'),
  ],
};

const DOCUMENTS = [STANDARD];
for (const doc of DOCUMENTS) validate(doc);

module.exports = { DOCUMENTS };

if (require.main === module) runCli(DOCUMENTS);
