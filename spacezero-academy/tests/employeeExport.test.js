'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { employeeWorkbook } = require('../lib/employeeExport');

test('employee export preserves names as text and never includes password fields', () => {
  const file = employeeWorkbook([{ fullName: 'O‘tkir & <Ali>', username: '=1+1', role: 'TRAVEL_AGENT', passwordHash: 'PRIVATE_HASH', password: 'PRIVATE_PASSWORD' }]);
  const zip = new AdmZip(file);
  const sheet = zip.readAsText('xl/worksheets/sheet1.xml');
  assert.match(sheet, /O‘tkir &amp; &lt;Ali&gt;/);
  assert.match(sheet, /t="inlineStr"[^>]*><is><t xml:space="preserve">=1\+1/);
  assert.doesNotMatch(sheet, /<f>|PRIVATE_HASH|PRIVATE_PASSWORD/);
  assert.match(sheet, /state="frozen"/);
  assert.match(sheet, /autoFilter ref="A1:D2"/);
  assert.match(sheet, /Travel Agent/);
  assert.ok(zip.getEntry('[Content_Types].xml'));
});

test('empty employee export still contains column headings', () => {
  const sheet = new AdmZip(employeeWorkbook([])).readAsText('xl/worksheets/sheet1.xml');
  assert.match(sheet, /Username/);
  assert.match(sheet, /Rol \/ Role/);
  assert.match(sheet, /dimension ref="A1:D1"/);
});

test('admins and named admin profiles have a separate sheet without duplicate employees', () => {
  const records = [
    { fullName: 'Admin', username: 'another-admin', role: 'ADMIN' },
    { fullName: 'Ali Agent', username: 'ali-agent', role: 'TRAVEL_AGENT' },
    { fullName: 'Employee', username: 'staff-demo', role: 'TRAVEL_AGENT' },
  ];
  const zip = new AdmZip(employeeWorkbook(records));
  const staff = zip.readAsText('xl/worksheets/sheet1.xml');
  const admins = zip.readAsText('xl/worksheets/sheet2.xml');
  assert.match(zip.readAsText('xl/workbook.xml'), /name="Admins"/);
  assert.match(staff, /staff-demo/);
  assert.doesNotMatch(staff, /another-admin|ali-agent/);
  assert.match(admins, /another-admin/);
  assert.match(admins, /ali-agent/);
  assert.doesNotMatch(admins, /staff-demo/);
});
