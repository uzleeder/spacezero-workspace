'use strict';
// The SpaceZero office inventory as it was handed over ("SpaceZero office PC.xlsx", product summary): product/model,
// category and quantity. Used by scripts/office-seed.cjs (a new database) and scripts/office-backfill.cjs (records that
// were loaded from this same list before asset tags and models existed).
module.exports = [
  ['Monitor Ziffler 24"', 'MONITOR', 28],
  ['Monitor Redmi 27"', 'MONITOR', 6],
  ['Monitor Redmi 24"', 'MONITOR', 14],
  ['Case myPro', 'CASE', 17],
  ['Case Aero BK', 'CASE', 7],
  ['Mouse', 'MOUSE', 23],
  ['Keyboard', 'KEYBOARD', 21],
  ['Chair', 'FURNITURE', 25],
  ['Table', 'FURNITURE', 24],
  ['TV', 'TV', 1],
  ['Headphone', 'HEADPHONES', 22],
  ['Fridge', 'APPLIANCE', 1],
  ['Microwave', 'APPLIANCE', 1],
  ['Boiler', 'APPLIANCE', 1],
  ['Printer', 'PRINTER', 1],
  ['Kitchen table', 'FURNITURE', 2],
  ['Kitchen chair', 'FURNITURE', 8],
  ['Mouse pad', 'ACCESSORY', 24],
  ['Coffee Machine', 'APPLIANCE', 1],
];
