'use strict';

function loginAsScope(admin) {
  return {
    organizationId: admin.organizationId,
    status: 'ACTIVE',
    archivedAt: null,
    role: { in: ['SUPERVISOR', 'TRAVEL_AGENT', 'FLIGHT_EXPERT'] },
    OR: [{ testOwnerAdminId: null }, { testOwnerAdminId: admin.id }],
  };
}

// A profile that's another admin's personal test account (testOwnerAdminId
// set to someone else) must stay invisible to every other admin — in the
// employee list/detail pages and any picker/recipient query, not just the
// "Login as" switcher. Spread this into a profile where-clause alongside
// other filters.
function excludeOtherAdminsTestProfiles(admin) {
  return { OR: [{ testOwnerAdminId: null }, { testOwnerAdminId: admin.id }] };
}

module.exports = { loginAsScope, excludeOtherAdminsTestProfiles };
