'use strict';

// Recommended skill taxonomy per role, grouped into categories. This is only a STARTING POINT: skills and
// categories are ordinary rows an Admin manages in Settings → Skills & categories (add, rename, move,
// archive). Nothing in the UI depends on these names; screens group by whatever categories exist.
const { prisma } = require('./prisma');

const DEFAULT_TAXONOMY = {
  TRAVEL_AGENT: {
    Sales: ['Discovery Questions', 'Client Engagement', 'Objection Handling', 'Closing', 'Price Presentation', 'Follow-Up'],
    Communication: ['Professionalism', 'Listening', 'Clarity', 'Confidence', 'Call Control'],
    Product: ['Aircraft Knowledge', 'Airline Knowledge', 'Business Class Knowledge', 'First Class Knowledge', 'Lounges', 'Premium Products'],
    Process: ['CRM', 'Company SOP', 'Payment Procedures', 'Booking Workflow'],
  },
  FLIGHT_EXPERT: {
    'GDS / Technical': ['Sabre Availability', 'Fare Search', 'Routing', 'Booking Classes', 'Fare Rules', 'Ticketing', 'Error Diagnosis'],
    Product: ['Aircraft Knowledge', 'Cabin Validation', 'Airline Products', 'Connections'],
    Process: ['Search Workflow', 'Quality Control', 'Company SOP'],
  },
  SUPERVISOR: {
    Leadership: ['Coaching', 'Feedback', 'Team Development'],
    Communication: ['Communication', 'Decision Making'],
    Process: ['Process Compliance'],
  },
};

// Categories written by the original seed; safe to replace with the grouped ones. An Admin's own
// category names are never overwritten.
const LEGACY_CATEGORIES = new Set(['Sales Skills', 'Technical Skills', '']);

/** Adds the recommended skills an organization is missing and groups legacy-seeded ones. Idempotent. */
async function ensureTaxonomy(organizationId) {
  const existing = await prisma.skill.findMany({ where: { organizationId } });
  const byKey = new Map(existing.map((s) => [`${s.roleKey || ''}|${s.name.trim().toLowerCase()}`, s]));
  let created = 0; let regrouped = 0;
  for (const [roleKey, categories] of Object.entries(DEFAULT_TAXONOMY)) {
    let order = 0;
    for (const [category, names] of Object.entries(categories)) {
      for (const name of names) {
        order += 1;
        const found = byKey.get(`${roleKey}|${name.toLowerCase()}`);
        if (!found) {
          await prisma.skill.create({ data: { organizationId, roleKey, name, category, displayOrder: order } });
          created += 1;
        } else if (LEGACY_CATEGORIES.has((found.category || '').trim())) {
          await prisma.skill.update({ where: { id: found.id }, data: { category, displayOrder: order } });
          regrouped += 1;
        }
      }
    }
  }
  return { created, regrouped };
}

module.exports = { DEFAULT_TAXONOMY, ensureTaxonomy };
