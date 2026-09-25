'use strict';

function monthsSince(startDate) {
  const now = new Date();
  let months = (now.getFullYear() - startDate.getFullYear()) * 12 + (now.getMonth() - startDate.getMonth());
  if (now.getDate() < startDate.getDate()) months -= 1;
  return Math.max(0, months);
}

// Bands are admin-configurable (see TenureBand table / Settings page) —
// never hard-code "0-3 months" style categories in application code.
function resolveTenureBand(employmentStartDate, bands) {
  const months = monthsSince(employmentStartDate);
  const sorted = [...bands].sort((a, b) => a.minMonths - b.minMonths);
  for (const band of sorted) {
    const withinMin = months >= band.minMonths;
    const withinMax = band.maxMonths === null || band.maxMonths === undefined || months < band.maxMonths;
    if (withinMin && withinMax) return band;
  }
  return null;
}

module.exports = { monthsSince, resolveTenureBand };
