'use strict';

const { prisma } = require('../lib/prisma');

const AGENT_SKILLS = [
  'Discovery Questions',
  'Call Control',
  'Client Engagement',
  'Product Knowledge',
  'Aircraft Knowledge',
  'Business Class Knowledge',
  'First Class Knowledge',
  'Objection Handling',
  'Confidence',
  'Closing',
  'Follow-Up',
];

const FLIGHT_EXPERT_SKILLS = [
  'Sabre Availability',
  'Fare Search',
  'Routing',
  'Booking Classes',
  'Fare Rules',
  'Ticketing',
  'Cabin Validation',
  'Aircraft Knowledge',
  'Error Diagnosis',
];

const LIBRARY_CATEGORIES = [
  'Airlines',
  'Business Class Cabins',
  'First Class Cabins',
  'Aircraft',
  'Seats',
  'Lounges',
  'Airports',
  'Sabre',
  'Fare Rules',
  'Sales Knowledge',
  'SOPs',
  'Company Procedures',
];

async function main() {
  const organization = await prisma.organization.upsert({
    where: { id: 'org_above9travel' },
    update: {},
    create: { id: 'org_above9travel', name: 'Above9 Travel' },
  });

  const existingRoles = await prisma.role.count();
  if (existingRoles === 0) {
    await prisma.role.createMany({
      data: [
        { key: 'ADMIN', label: 'Administrator', description: 'Senior manager with complete organizational access.' },
        { key: 'SUPERVISOR', label: 'Supervisor', description: 'Manages a set of assigned Travel Agents.' },
        {
          key: 'TRAVEL_AGENT',
          label: 'Travel Agent',
          description: 'Premium consultant selling Business and First Class travel.',
        },
        {
          key: 'FLIGHT_EXPERT',
          label: 'Flight Expert',
          description: 'Supports Travel Agents by finding and constructing flight options.',
        },
      ],
    });
  }

  const existingBands = await prisma.tenureBand.count({ where: { organizationId: organization.id } });
  if (existingBands === 0) {
    await prisma.tenureBand.createMany({
      data: [
        { organizationId: organization.id, label: 'New Agent', minMonths: 0, maxMonths: 3, displayOrder: 1 },
        { organizationId: organization.id, label: 'Semi-experienced', minMonths: 3, maxMonths: 6, displayOrder: 2 },
        { organizationId: organization.id, label: 'Experienced Agent', minMonths: 6, maxMonths: null, displayOrder: 3 },
      ],
    });
  }

  const existingSkills = await prisma.skill.count({ where: { organizationId: organization.id } });
  if (existingSkills === 0) {
    await prisma.skill.createMany({
      data: [
        ...AGENT_SKILLS.map((name, i) => ({
          organizationId: organization.id,
          roleKey: 'TRAVEL_AGENT',
          name,
          category: 'Sales Skills',
          displayOrder: i,
        })),
        ...FLIGHT_EXPERT_SKILLS.map((name, i) => ({
          organizationId: organization.id,
          roleKey: 'FLIGHT_EXPERT',
          name,
          category: 'Technical Skills',
          displayOrder: i,
        })),
      ],
    });
  }

  const existingCategories = await prisma.libraryCategory.count({ where: { organizationId: organization.id } });
  if (existingCategories === 0) {
    await prisma.libraryCategory.createMany({
      data: LIBRARY_CATEGORIES.map((name, i) => ({ organizationId: organization.id, name, displayOrder: i })),
    });
  }

  // Account creation is invitation-only: the bootstrap admin is created WITHOUT a password. The
  // one-time activation link is printed here (it is not stored anywhere else); open it and choose
  // your own password. No shared or default password exists in this repository.
  const adminEmail = 'admin@above9travel.com';
  const existingAdmin = await prisma.profile.findUnique({ where: { email: adminEmail } });
  if (!existingAdmin && (await prisma.profile.count({ where: { organizationId: organization.id, role: 'ADMIN' } })) === 0) {
    const { generateToken } = require('../lib/tokens');
    const { raw, hash } = generateToken();
    const admin = await prisma.profile.create({
      data: {
        organizationId: organization.id,
        fullName: 'Head Administrator',
        username: 'admin',
        email: adminEmail,
        role: 'ADMIN',
        status: 'INVITED',
        employmentStartDate: new Date(),
      },
    });
    await prisma.invitation.create({ data: { profileId: admin.id, tokenHash: hash, invitedById: admin.id, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
    const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
    console.log(`Seed: bootstrap admin created (${adminEmail}). Activate it within 24 hours: ${origin}/accept-invite/${raw}`);
  }
  console.log('Seed completed.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
