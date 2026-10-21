'use strict';

// Turns the file kinds a browser cannot draw by itself into safe HTML / SVG for the reading page (views/training-read.ejs):
// plain text, Markdown, RTF, HTML (as text), OpenDocument text, spreadsheets (XLSX / ODS / CSV / TSV), EPUB e-books,
// OpenDocument presentations and DXF drawings. Pure JavaScript, no conversion service. Everything produced is built from
// escaped text: nothing from the file can run (no scripts, no links, no styles, no events).
const fs = require('node:fs');
const path = require('node:path');
const { resolveStoragePath } = require('./storage');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const stripTags = (s) => unxml(String(s).replace(/<[^>]*>/g, ''));
const MAX_BYTES = 12 * 1024 * 1024;
const abs = (storagePath) => (path.isAbsolute(storagePath) ? storagePath : resolveStoragePath(storagePath)); // storage-relative, or already absolute (the AI analysis passes absolute paths)
const readText = (storagePath) => { const file = abs(storagePath); if (fs.statSync(file).size > MAX_BYTES) throw new Error('too large'); return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); };
const zipOf = (storagePath) => new (require('adm-zip'))(abs(storagePath));
const entryText = (zip, name) => { const e = zip.getEntry(name); return e ? e.getData().toString('utf8') : null; };
const safe = (fn) => { try { return fn(); } catch { return null; } };

// ---------------------------------------------------------------- plain text, Markdown, RTF, HTML (as text)
function htmlToText(html) {
  return unxml(String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n\n').replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
}
function rtfToText(rtf) {
  return String(rtf)
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode(Number(n) < 0 ? Number(n) + 65536 : Number(n)))
    .replace(/\{\\\*[^{}]*\}/g, '').replace(/\{\\(fonttbl|colortbl|stylesheet|info)[\s\S]*?\}\}?/g, '')
    .replace(/\\(par|line)\b ?/g, '\n').replace(/\\tab\b ?/g, '\t').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}
/** A small, safe Markdown view: headings, lists, bold / italic / code, paragraphs. Everything else stays as text. */
function markdownHtml(md) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  const out = []; let list = null; let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of String(md).split('\n')) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line); const ul = /^\s*[-*+]\s+(.*)$/.exec(line); const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) { flush(); closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
    else if (ul || ol) { flush(); const kind = ul ? 'ul' : 'ol'; if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; } out.push(`<li>${inline((ul || ol)[1])}</li>`); }
    else if (!line.trim()) { flush(); closeList(); }
    else { closeList(); para.push(line.trim()); }
  }
  flush(); closeList();
  return out.join('\n');
}
function textHtml(storagePath) {
  return safe(() => {
    const ext = path.extname(storagePath).toLowerCase();
    const raw = readText(storagePath);
    if (ext === '.md') return markdownHtml(raw);
    const text = ext === '.rtf' ? rtfToText(raw) : (ext === '.html' || ext === '.htm') ? htmlToText(raw) : raw;
    return text.trim() ? `<div class="doc-reader__plain">${esc(text)}</div>` : null;
  });
}

// ---------------------------------------------------------------- OpenDocument text (.odt)
function odtHtml(storagePath) {
  return safe(() => {
    const xml = entryText(zipOf(storagePath), 'content.xml');
    if (!xml) return null;
    const body = (/<office:text[^>]*>([\s\S]*)<\/office:text>/.exec(xml) || [])[1] || '';
    const out = [];
    const walk = (chunk) => {
      const re = /<text:h\b[^>]*text:outline-level="(\d+)"[^>]*>([\s\S]*?)<\/text:h>|<text:p\b[^>]*>([\s\S]*?)<\/text:p>|<text:list\b[^>]*>([\s\S]*?)<\/text:list>|<table:table\b[^>]*>([\s\S]*?)<\/table:table>/g;
      let m;
      while ((m = re.exec(chunk))) {
        if (m[1]) out.push(`<h${Math.min(4, Number(m[1]))}>${esc(stripTags(m[2].replace(/<text:line-break\/>/g, ' ')))}</h${Math.min(4, Number(m[1]))}>`);
        else if (m[3] !== undefined) { const t = stripTags(m[3].replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<text:s[^>]*\/>/g, ' ')); if (t.trim()) out.push(`<p>${esc(t)}</p>`); }
        else if (m[4] !== undefined) { out.push('<ul>' + [...m[4].matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)].map((x) => `<li>${esc(stripTags(x[1]))}</li>`).join('') + '</ul>'); }
        else if (m[5] !== undefined) { out.push('<table>' + [...m[5].matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g)].map((r) => '<tr>' + [...r[1].matchAll(/<table:table-cell\b[^>]*>([\s\S]*?)<\/table:table-cell>/g)].map((c) => `<td>${esc(stripTags(c[1].replace(/<\/text:p>/g, ' ')))}</td>`).join('') + '</tr>').join('') + '</table>'); }
      }
    };
    walk(body);
    return out.length ? out.join('\n') : null;
  });
}

// ---------------------------------------------------------------- OpenDocument presentation (.odp) -> slides
function odpSlides(storagePath) {
  return safe(() => {
    const xml = entryText(zipOf(storagePath), 'content.xml');
    if (!xml) return null;
    const pages = [...xml.matchAll(/<draw:page\b[^>]*>([\s\S]*?)<\/draw:page>/g)];
    const slides = pages.map((p, i) => {
      const lines = [...p[1].matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)].map((m) => stripTags(m[1])).filter((s) => s.trim());
      return { number: i + 1, title: lines.shift() || '', lines, images: [] };
    });
    return slides.length ? slides : null;
  });
}

// ---------------------------------------------------------------- spreadsheets
const MAX_ROWS = 500; const MAX_COLS = 40;
const colIndex = (ref) => { let n = 0; for (const ch of /^[A-Z]+/i.exec(ref)[0].toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

function tableHtml(name, rows, truncatedRows) {
  const width = Math.min(MAX_COLS, rows.reduce((n, r) => Math.max(n, r.length), 0));
  if (!width) return `<section class="doc-reader__sheet"><h2>${esc(name)}</h2><p class="doc-reader__note">This sheet is empty.</p></section>`;
  const head = '<tr><th></th>' + Array.from({ length: width }, (_, i) => `<th>${colName(i)}</th>`).join('') + '</tr>';
  const body = rows.map((r, ri) => `<tr><th>${ri + 1}</th>${Array.from({ length: width }, (_, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('');
  return `<section class="doc-reader__sheet"><h2>${esc(name)}</h2><div class="doc-reader__scroll"><table>${head}${body}</table></div>${truncatedRows ? `<p class="doc-reader__note">The first ${MAX_ROWS} rows are shown (${truncatedRows} more rows are not displayed).</p>` : ''}</section>`;
}
function parseDelimited(text, delimiter) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function xlsxSheets(storagePath) {
  const zip = zipOf(storagePath);
  const shared = (entryText(zip, 'xl/sharedStrings.xml') || '').split(/<si\b[^>]*>/).slice(1).map((si) => [...si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join(''));
  const wb = entryText(zip, 'xl/workbook.xml') || '';
  const rels = {}; for (const m of (entryText(zip, 'xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)) { const id = /Id="([^"]+)"/.exec(m[0]); const target = /Target="([^"]+)"/.exec(m[0]); if (id && target) rels[id[1]] = target[1]; }
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = /name="([^"]*)"/.exec(m[0]); const rid = /r:id="([^"]+)"/.exec(m[0]);
    if (!name || !rid || !rels[rid[1]]) continue;
    const target = rels[rid[1]].replace(/^\//, ''); const xml = entryText(zip, target.startsWith('xl/') ? target : `xl/${target}`);
    if (!xml) continue;
    const rows = []; let more = 0;
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= MAX_ROWS) { more += 1; continue; }
      const cells = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+\d+)"/.exec(c[1]); if (!ref) continue;
        const type = (/t="([^"]+)"/.exec(c[1]) || [])[1]; const v = (/<v>([\s\S]*?)<\/v>/.exec(c[2] || '') || [])[1]; const inline = /<is>([\s\S]*?)<\/is>/.exec(c[2] || '');
        let value = '';
        if (type === 's') value = shared[Number(v)] ?? ''; else if (type === 'inlineStr' && inline) value = stripTags(inline[1]); else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE'; else if (v !== undefined) value = unxml(v);
        const idx = colIndex(ref[1]); if (idx < MAX_COLS) cells[idx] = value;
      }
      rows.push(cells);
    }
    sheets.push({ name: unxml(name[1]), rows, more });
  }
  return sheets;
}
function odsSheets(storagePath) {
  const xml = entryText(zipOf(storagePath), 'content.xml') || '';
  return [...xml.matchAll(/<table:table\b[^>]*table:name="([^"]*)"[^>]*>([\s\S]*?)<\/table:table>/g)].map((t) => {
    const rows = []; let more = 0;
    for (const r of t[2].matchAll(/<table:table-row\b([^>]*)>([\s\S]*?)<\/table:table-row>/g)) {
      const repeat = Math.min(50, Number((/number-rows-repeated="(\d+)"/.exec(r[1]) || [])[1] || 1));
      const cells = [];
      for (const c of r[2].matchAll(/<table:table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g)) {
        const rep = Math.min(MAX_COLS, Number((/number-columns-repeated="(\d+)"/.exec(c[1]) || [])[1] || 1));
        const value = stripTags((c[2] || '').replace(/<\/text:p>/g, ' ')).trim();
        for (let k = 0; k < rep && cells.length < MAX_COLS; k++) cells.push(value);
      }
      for (let k = 0; k < repeat; k++) { if (rows.length >= MAX_ROWS) { more += 1; } else if (cells.some((x) => x !== '') || k === 0) rows.push(cells.slice()); }
    }
    while (rows.length && rows[rows.length - 1].every((x) => x === '')) rows.pop();
    return { name: unxml(t[1]), rows, more };
  });
}
function sheetsHtml(storagePath) {
  return safe(() => {
    const ext = path.extname(storagePath).toLowerCase();
    let sheets;
    if (ext === '.xlsx') sheets = xlsxSheets(storagePath);
    else if (ext === '.ods') sheets = odsSheets(storagePath);
    else { const rows = parseDelimited(readText(storagePath), ext === '.tsv' ? '\t' : (readText(storagePath).split('\n')[0].split(';').length > readText(storagePath).split('\n')[0].split(',').length ? ';' : ',')); sheets = [{ name: path.basename(storagePath), rows: rows.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS)), more: Math.max(0, rows.length - MAX_ROWS) }]; }
    return sheets && sheets.length ? sheets.map((s) => tableHtml(s.name, s.rows, s.more)).join('\n') : null;
  });
}

// ---------------------------------------------------------------- EPUB e-books
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
function sanitizeChapter(html, zip, baseDir, budget) {
  let body = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html) || [null, html])[1];
  body = body
    .replace(/<(script|style|link|meta|iframe|object|embed|form|svg|audio|video|canvas|math)\b[\s\S]*?(<\/\1>|\/>)/gi, '')
    .replace(/<\/?(script|style|link|meta|iframe|object|embed|form|input|button|select|textarea)\b[^>]*>/gi, '')
    .replace(/<a\b[^>]*>/gi, '<span>').replace(/<\/a>/gi, '</span>')
    .replace(/\s(on\w+|style|class|id|href|xlink:href|srcset)=("[^"]*"|'[^']*')/gi, '');
  return body.replace(/<img\b[^>]*?\ssrc=("([^"]*)"|'([^']*)')[^>]*>/gi, (_, __, a, b) => {
    const src = (a || b || '').split('#')[0];
    const target = path.posix.normalize(path.posix.join(baseDir, decodeURIComponent(src)));
    const mime = IMAGE_MIME[path.extname(target).toLowerCase()]; const entry = zip.getEntry(target);
    if (!mime || !entry || entry.header.size > 3 * 1024 * 1024 || budget.left < entry.header.size) return '';
    budget.left -= entry.header.size;
    return `<img alt="" src="data:${mime};base64,${entry.getData().toString('base64')}">`;
  }).replace(/<(\w+)\b[^>]*?\s(on\w+)=/gi, '<$1 data-x=');
}
function epubHtml(storagePath) {
  return safe(() => {
    const zip = zipOf(storagePath);
    const container = entryText(zip, 'META-INF/container.xml') || '';
    const opfPath = (/full-path="([^"]+)"/.exec(container) || [])[1];
    const opf = opfPath && entryText(zip, opfPath);
    if (!opf) return null;
    const dir = path.posix.dirname(opfPath);
    const manifest = {}; for (const m of opf.matchAll(/<item\b[^>]*>/g)) { const id = /\bid="([^"]+)"/.exec(m[0]); const href = /href="([^"]+)"/.exec(m[0]); if (id && href) manifest[id[1]] = href[1]; }
    const budget = { left: 25 * 1024 * 1024 }; const chapters = [];
    for (const m of [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].slice(0, 120)) {
      const href = manifest[m[1]]; if (!href) continue;
      const file = path.posix.join(dir === '.' ? '' : dir, decodeURIComponent(href));
      const xhtml = entryText(zip, file); if (!xhtml) continue;
      const chapter = sanitizeChapter(xhtml, zip, path.posix.dirname(file), budget);
      if (stripTags(chapter).trim() || /<img/.test(chapter)) chapters.push(`<section class="doc-reader__chapter">${chapter}</section>`);
    }
    return chapters.length ? chapters.join('\n') : null;
  });
}

// ---------------------------------------------------------------- DXF drawings -> SVG
function dxfSvg(storagePath) {
  return safe(() => {
    const lines = readText(storagePath).split(/\r?\n/);
    const pairs = []; for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([Number(lines[i].trim()), lines[i + 1].trim()]);
    const start = pairs.findIndex((p, i) => p[0] === 2 && p[1] === 'ENTITIES' && pairs[i - 1] && pairs[i - 1][1] === 'SECTION');
    if (start < 0) return null;
    const items = []; let cur = null;
    const num = (e, code, n = 0) => { const vals = e.f[code]; return vals && vals[n] !== undefined ? Number(vals[n]) : 0; };
    for (let i = start + 1; i < pairs.length; i++) {
      const [code, value] = pairs[i];
      if (code === 0) {
        if (cur) items.push(cur);
        if (value === 'ENDSEC') { cur = null; break; }
        cur = { t: value, f: {} };
        continue;
      }
      if (cur) (cur.f[code] = cur.f[code] || []).push(value);
    }
    if (cur) items.push(cur);
    const shapes = []; const pts = []; let count = 0;
    const P = (x, y) => { pts.push([x, -y]); return `${x.toFixed(3)},${(-y).toFixed(3)}`; };
    for (const e of items) {
      if (++count > 20000) break;
      if (e.t === 'LINE') shapes.push(`<path d="M${P(num(e, 10), num(e, 20))} L${P(num(e, 11), num(e, 21))}"/>`);
      else if (e.t === 'CIRCLE') { const [cx, cy, r] = [num(e, 10), num(e, 20), num(e, 40)]; P(cx - r, cy - r); P(cx + r, cy + r); shapes.push(`<circle cx="${cx}" cy="${-cy}" r="${r}"/>`); }
      else if (e.t === 'ARC') {
        const [cx, cy, r, a0, a1] = [num(e, 10), num(e, 20), num(e, 40), num(e, 50) * Math.PI / 180, num(e, 51) * Math.PI / 180];
        const pt = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
        const [sx, sy] = pt(a0), [ex, ey] = pt(a1); let sweep = ((a1 - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        P(cx - r, cy - r); P(cx + r, cy + r);
        shapes.push(`<path d="M${sx.toFixed(3)},${(-sy).toFixed(3)} A${r},${r} 0 ${sweep > Math.PI ? 1 : 0} 0 ${ex.toFixed(3)},${(-ey).toFixed(3)}"/>`);
      } else if (e.t === 'LWPOLYLINE') {
        const xs = e.f[10] || []; const ys = e.f[20] || []; const closed = (Number((e.f[70] || [0])[0]) & 1) === 1;
        if (xs.length > 1) shapes.push(`<path d="M${xs.map((x, k) => P(Number(x), Number(ys[k] || 0))).join(' L')}${closed ? ' Z' : ''}"/>`);
      } else if (e.t === 'TEXT' || e.t === 'MTEXT') {
        const [x, y, h] = [num(e, 10), num(e, 20), num(e, 40) || 2.5]; P(x, y);
        shapes.push(`<text x="${x}" y="${-y}" font-size="${h}" stroke="none" fill="#1c2233">${esc((e.f[1] || []).join(' ').replace(/\\P/g, ' ').replace(/\{[^}]*;/g, '').replace(/[{}]/g, ''))}</text>`);
      }
    }
    if (!shapes.length || !pts.length) return null;
    const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const w = Math.max(maxX - minX, 1); const h = Math.max(maxY - minY, 1); const pad = Math.max(w, h) * 0.04;
    return `<svg class="doc-reader__cad" xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${minY - pad} ${w + 2 * pad} ${h + 2 * pad}" preserveAspectRatio="xMidYMid meet" role="img" fill="none" stroke="#1c2233" stroke-width="1.2" style="vector-effect:non-scaling-stroke"><g vector-effect="non-scaling-stroke">${shapes.join('')}</g></svg>`;
  });
}

/** The text of any of these files, for the AI analysis (null when there is no readable text). */
function plainText(storagePath) {
  const ext = path.extname(storagePath).toLowerCase();
  const html = ['.txt', '.md', '.html', '.htm', '.rtf'].includes(ext) ? textHtml(storagePath) : ext === '.odt' ? odtHtml(storagePath) : ['.xlsx', '.ods', '.csv', '.tsv'].includes(ext) ? sheetsHtml(storagePath) : ext === '.epub' ? epubHtml(storagePath) : null;
  if (ext === '.txt' || ext === '.csv' || ext === '.tsv') return safe(() => readText(storagePath).slice(0, 400000));
  return html ? htmlToText(html.replace(/<\/(td|th)>/g, '\t').replace(/<\/tr>/g, '\n')).slice(0, 400000) : null;
}

module.exports = { esc, htmlToText, rtfToText, markdownHtml, textHtml, odtHtml, odpSlides, sheetsHtml, epubHtml, dxfSvg, plainText };
