'use strict';

const AdmZip = require('adm-zip');
const { roleLabel } = require('./roles');

function xml(value) {
  // XML 1.0 disallows these control characters in spreadsheet cell text.
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function singleSheetWorkbook(employees) {
  const zip = new AdmZip();
  const add = (name, content) => zip.addFile(name, Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + content));
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rows = [['Ism / Full name', 'Username', 'Rol / Role', 'Parol / Password (user-provided)'], ...employees.map(e => [e.fullName, e.username, roleLabel(e.role), e.exportPassword ?? ''])];
  const data = rows.map((row, i) => `<row r="${i + 1}" ht="26" customHeight="1">${row.map((value, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr" s="${i === 0 ? 1 : 0}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`).join('')}</row>`).join('');
  add('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>');
  add('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  add('xl/workbook.xml', `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Employees" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  add('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  add('xl/styles.xml', `<styleSheet xmlns="${ns}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF101E32"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  add('xl/worksheets/sheet1.xml', `<worksheet xmlns="${ns}"><dimension ref="A1:D${rows.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="36" customWidth="1"/><col min="2" max="2" width="28" customWidth="1"/><col min="3" max="3" width="24" customWidth="1"/><col min="4" max="4" width="48" customWidth="1"/></cols><sheetData>${data}</sheetData><autoFilter ref="A1:D${rows.length}"/></worksheet>`);
  return zip.toBuffer();
}

// Explicitly requested admin-associated profiles; no passwords are stored here.
const ADMIN_USERNAMES = new Set(['ali', 'ali-agent', 'ali-expert', 'ali-supervisor', 'joe', 'tom']);
function employeeWorkbook(employees) {
  const isAdmin = e => e.role === 'ADMIN' || ADMIN_USERNAMES.has(String(e.username).toLowerCase());
  const staff = employees.filter(e => !isAdmin(e));
  const admins = employees.filter(isAdmin);
  const zip = new AdmZip(singleSheetWorkbook(staff));
  const adminZip = new AdmZip(singleSheetWorkbook(admins));
  zip.addFile('xl/worksheets/sheet2.xml', adminZip.readFile('xl/worksheets/sheet1.xml'));
  const replace = (file, from, to) => zip.updateFile(file, Buffer.from(zip.readAsText(file).replace(from, to)));
  replace('xl/workbook.xml', '</sheets>', '<sheet name="Admins" sheetId="2" r:id="rId3"/></sheets>');
  replace('xl/_rels/workbook.xml.rels', '</Relationships>', '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>');
  replace('[Content_Types].xml', '</Types>', '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  return zip.toBuffer();
}
module.exports = { employeeWorkbook };
