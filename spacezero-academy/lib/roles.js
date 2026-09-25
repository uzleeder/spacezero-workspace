'use strict';

const ROLE_LABELS = {
  ADMIN: 'Administrator',
  SUPERVISOR: 'Supervisor',
  TRAVEL_AGENT: 'Travel Agent',
  FLIGHT_EXPERT: 'Flight Expert',
};

const ROLE_DESCRIPTIONS = {
  ADMIN: 'Senior manager with complete organizational access.',
  SUPERVISOR: 'Manages a set of assigned Travel Agents.',
  TRAVEL_AGENT: 'Premium consultant selling Business and First Class travel.',
  FLIGHT_EXPERT: 'Supports Travel Agents by finding and constructing flight options.',
};

const ALL_ROLES = ['ADMIN', 'SUPERVISOR', 'TRAVEL_AGENT', 'FLIGHT_EXPERT'];

function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

module.exports = { ROLE_LABELS, ROLE_DESCRIPTIONS, ALL_ROLES, roleLabel };
