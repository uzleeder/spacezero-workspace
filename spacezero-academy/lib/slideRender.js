'use strict';

// A PowerPoint (.pptx) drawn the way it was made: every shape, text box, picture and table at its own position and size on a
// slide-shaped canvas, with the slide's background, the master / layout artwork behind it, and the text's own size, colour,
// bold / italic, alignment and bullets. Positions are percentages of the slide and text sizes are container-width units
// (cqw), so the whole slide scales as one picture to any screen. Everything that goes into the page is escaped or checked:
// colours must be hex, pictures are inlined as data: images, nothing is executable and nothing is loaded from outside.
const path = require('path');
const AdmZip = require('adm-zip');
const { DOMParser } = require('@xmldom/xmldom'); // ships with mammoth, which the app already depends on
const { resolveStoragePath } = require('./storage');

const EMU_PT = 12700;
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' };
const MAX_DECK = 40 * 1024 * 1024;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- small DOM helpers (namespace prefixes are ignored: we match on local names) ----
const kids = (el, name) => (el ? Array.from(el.childNodes).filter((n) => n.nodeType === 1 && (!name || n.localName === name)) : []);
const kid = (el, name) => kids(el, name)[0] || null;
const attr = (el, name) => (el && el.getAttribute(name) !== '' ? el.getAttribute(name) : null);
const num = (v, d = 0) => { if (v == null || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
const dig = (el, ...names) => names.reduce((cur, n) => (cur ? kid(cur, n) : null), el);
const parse = (xml) => new DOMParser({ errorHandler: () => undefined }).parseFromString(xml, 'text/xml');

// ---- colours ----
function hslOf([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6;
  }
  return [h, s, l];
}
function rgbOf([h, s, l]) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => Math.round(v * 255));
}
const hexRgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
const SCHEME = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };

/** The CSS colour of a fill / colour element (solidFill, or a colour node itself); null when it has none. */
function colorOf(holder, ctx) {
  if (!holder) return null;
  const node = ['srgbClr', 'schemeClr', 'sysClr', 'prstClr'].includes(holder.localName) ? holder : kids(holder).find((n) => ['srgbClr', 'schemeClr', 'sysClr', 'prstClr'].includes(n.localName));
  if (!node) return null;
  let hex;
  if (node.localName === 'srgbClr') hex = attr(node, 'val');
  else if (node.localName === 'sysClr') hex = attr(node, 'lastClr') || (attr(node, 'val') === 'window' ? 'FFFFFF' : '000000');
  else if (node.localName === 'prstClr') hex = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00' }[attr(node, 'val')] || '000000';
  else {
    const name = attr(node, 'val');
    const mapped = ctx.clrMap[name] || SCHEME[name] || name;
    hex = ctx.theme[mapped] || (name === 'phClr' ? ctx.phClr : null);
  }
  if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  let rgb = hexRgb(hex); let alpha = 1;
  for (const m of kids(node)) {
    const v = num(attr(m, 'val'), 100000) / 100000;
    if (m.localName === 'lumMod' || m.localName === 'lumOff') { const hsl = hslOf(rgb); if (m.localName === 'lumMod') hsl[2] = Math.min(1, hsl[2] * v); else hsl[2] = Math.min(1, hsl[2] + v); rgb = rgbOf(hsl); }
    else if (m.localName === 'tint') rgb = rgb.map((c) => Math.round(c + (255 - c) * (1 - v)));
    else if (m.localName === 'shade') rgb = rgb.map((c) => Math.round(c * v));
    else if (m.localName === 'alpha') alpha = v;
  }
  return alpha < 1 ? `rgba(${rgb.join(',')},${alpha.toFixed(2)})` : `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

// ---- the package ----
function relsOf(zip, partPath) {
  const dir = path.posix.dirname(partPath); const entry = zip.getEntry(`${dir}/_rels/${path.posix.basename(partPath)}.rels`);
  const map = {};
  if (!entry) return map;
  for (const rel of Array.from(parse(entry.getData().toString('utf8')).getElementsByTagName('Relationship'))) {
    const id = rel.getAttribute('Id'); let target = rel.getAttribute('Target');
    if (!id || !target || rel.getAttribute('TargetMode') === 'External') continue;
    target = target.startsWith('/') ? target.slice(1) : path.posix.normalize(`${dir}/${target}`);
    map[id] = { target, type: String(rel.getAttribute('Type') || '').split('/').pop() };
  }
  return map;
}

function readTheme(zip, masterPath) {
  const theme = {};
  const rel = Object.values(relsOf(zip, masterPath)).find((r) => r.type === 'theme');
  const entry = rel && zip.getEntry(rel.target);
  if (!entry) return { dk1: '000000', lt1: 'FFFFFF' };
  const scheme = parse(entry.getData().toString('utf8')).getElementsByTagName('a:clrScheme')[0];
  for (const c of kids(scheme)) { const n = kids(c)[0]; if (n) theme[c.localName] = attr(n, 'val') === 'window' ? 'FFFFFF' : attr(n, 'val') === 'windowText' ? '000000' : (attr(n, 'lastClr') || attr(n, 'val')); }
  return theme;
}

const clrMapOf = (master) => { const m = kid(master, 'clrMap'); const out = {}; if (m) for (const a of Array.from(m.attributes)) out[a.name] = SCHEME[a.value] || a.value; return out; };

// ---- placeholders ----
const phOf = (sp) => dig(sp, 'nvSpPr', 'nvPr', 'ph') || dig(sp, 'nvPicPr', 'nvPr', 'ph') || dig(sp, 'nvGraphicFramePr', 'nvPr', 'ph');
const normType = (t) => ({ ctrTitle: 'title', subTitle: 'body', obj: 'body' }[t] || t || 'body');
function findPlaceholder(tree, ph) {
  if (!tree || !ph) return null;
  const idx = attr(ph, 'idx'); const type = normType(attr(ph, 'type'));
  const all = kids(tree, 'sp').filter((s) => phOf(s));
  return (idx != null && all.find((s) => attr(phOf(s), 'idx') === idx)) || all.find((s) => normType(attr(phOf(s), 'type')) === type && (type !== 'body' || attr(phOf(s), 'idx') == null || idx == null)) || null;
}

function xfrmOf(sp) {
  const x = dig(sp, 'spPr', 'xfrm') || kid(sp, 'xfrm') || dig(sp, 'grpSpPr', 'xfrm');
  if (!x) return null;
  const off = kid(x, 'off'); const ext = kid(x, 'ext');
  if (!off || !ext) return null;
  return { x: num(attr(off, 'x')), y: num(attr(off, 'y')), w: num(attr(ext, 'cx')), h: num(attr(ext, 'cy')), rot: num(attr(x, 'rot')) / 60000, flipH: attr(x, 'flipH') === '1', flipV: attr(x, 'flipV') === '1' };
}

// ---- text ----
const TX_STYLE = { title: 'titleStyle', body: 'bodyStyle' };
/** The first value of a paragraph / run property found walking the style chain (own list style -> layout -> master -> master text styles). */
function styleLookup(chain, lvl, pick) {
  for (const c of chain) {
    if (!c) continue;
    const p = kid(c, `lvl${lvl}pPr`) || (lvl === 1 ? kid(c, 'defPPr') : null);
    const v = p && pick(p);
    if (v != null) return v;
  }
  return null;
}
const fromDef = (name) => (p) => attr(kid(p, 'defRPr'), name);
const ROMAN = [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
function numberLabel(type, n) {
  const alpha = (k) => { let s = ''; for (let i = k; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(97 + ((i - 1) % 26)) + s; return s; };
  const roman = (k) => { let s = ''; for (const [v, r] of ROMAN) while (k >= v) { s += r; k -= v; } return s; };
  const base = /^alpha/.test(type) ? alpha(n) : /^roman/.test(type) ? roman(n) : String(n);
  const cased = /Uc/.test(type) ? base.toUpperCase() : base;
  return /ParenR/.test(type) ? `${cased})` : /ParenBoth/.test(type) ? `(${cased})` : `${cased}.`;
}

function renderText(txBody, ctx, { chain, slideW, defaultSz }) {
  if (!txBody) return '';
  const body = kid(txBody, 'bodyPr');
  const fontScale = num(attr(kid(body, 'normAutofit'), 'fontScale'), 100000) / 100000;
  const own = kid(txBody, 'lstStyle');
  const full = [own, ...chain];
  const cq = (emu) => `${((emu / slideW) * 100).toFixed(3)}cqw`;
  const counters = {};
  // space before the first paragraph / after the last one only counts when the text box asks for it (spcFirstLastPara)
  const edgeSpacing = attr(body, 'spcFirstLastPara') === '1';
  const html = kids(txBody, 'p').map((p, pi, all) => {
    const pPr = kid(p, 'pPr'); const lvl = num(attr(pPr, 'lvl'), 0) + 1;
    const get = (pick) => { const direct = pPr && pick(pPr); return direct != null ? direct : styleLookup(full, lvl, pick); };
    const algn = get((q) => attr(q, 'algn')); const marL = num(get((q) => attr(q, 'marL')), 0); const indent = num(get((q) => attr(q, 'indent')), 0);
    const buNone = get((q) => (kid(q, 'buNone') ? 'none' : null)); const buChar = get((q) => attr(kid(q, 'buChar'), 'char')); const buAuto = get((q) => attr(kid(q, 'buAutoNum'), 'type'));
    const spcBef = pi === 0 && !edgeSpacing ? null : get((q) => attr(kid(kid(q, 'spcBef'), 'spcPts'), 'val'));
    const spcAft = pi === all.length - 1 && !edgeSpacing ? null : get((q) => attr(kid(kid(q, 'spcAft'), 'spcPts'), 'val'));
    const lnPct = get((q) => attr(kid(kid(q, 'lnSpc'), 'spcPct'), 'val'));
    const baseSz = num(get(fromDef('sz')), defaultSz) * fontScale;
    const baseColor = get((q) => colorOf(kid(kid(q, 'defRPr'), 'solidFill'), ctx)) || null;
    const baseBold = get(fromDef('b')) === '1'; const baseItalic = get(fromDef('i')) === '1';
    const runs = []; let firstSz = baseSz; let firstColor = baseColor || ctx.fontRefColor || null;
    for (const r of kids(p)) {
      if (r.localName === 'br') { runs.push('<br>'); continue; }
      if (!['r', 'fld'].includes(r.localName)) continue;
      const rPr = kid(r, 'rPr'); const text = Array.from(r.getElementsByTagName('a:t')).map((t) => t.textContent).join('');
      if (!text) continue;
      const sz = rPr && attr(rPr, 'sz') ? num(attr(rPr, 'sz')) * fontScale : baseSz;
      const color = colorOf(kid(rPr, 'solidFill'), ctx) || baseColor || ctx.fontRefColor || null;
      if (!runs.length) { firstSz = sz; firstColor = color; }
      const b = rPr && attr(rPr, 'b') != null ? attr(rPr, 'b') === '1' : baseBold; const i = rPr && attr(rPr, 'i') != null ? attr(rPr, 'i') === '1' : baseItalic;
      const u = rPr && attr(rPr, 'u') && attr(rPr, 'u') !== 'none';
      const style = [`font-size:${((sz / 100) * EMU_PT / slideW * 100).toFixed(3)}cqw`, color && `color:${color}`, b && 'font-weight:700', i && 'font-style:italic', u && 'text-decoration:underline'].filter(Boolean).join(';');
      runs.push(`<span style="${style}">${esc(text)}</span>`);
    }
    const sizeCq = ((firstSz / 100) * EMU_PT / slideW * 100);
    const align = { ctr: 'center', r: 'right', just: 'justify' }[algn] || 'left';
    let bullet = '';
    const bulleted = buNone !== 'none' && (buChar || buAuto);
    if (bulleted) {
      const hang = Math.max(0, -indent);
      let label = buChar ? esc(buChar) : '';
      if (buAuto) { counters[lvl] = (counters[lvl] || 0) + 1; label = esc(numberLabel(buAuto, counters[lvl])); } else counters[lvl] = 0;
      bullet = `<span style="display:inline-block;min-width:${cq(hang || EMU_PT * firstSz / 100)};text-indent:0${firstColor ? `;color:${firstColor}` : ''}">${label}</span>`;
    } else counters[lvl] = 0;
    const content = runs.join('') || '<br>';
    const style = [`text-align:${align}`, `margin:${spcBef ? cq(num(spcBef) / 100 * EMU_PT) : '0'} 0 ${spcAft ? cq(num(spcAft) / 100 * EMU_PT) : '0'}`, `line-height:${lnPct ? (num(lnPct) / 100000 * 1.2).toFixed(2) : '1.2'}`,
      `padding-left:${cq(Math.max(0, marL))}`, `text-indent:${cq(bulleted ? indent : 0)}`, `font-size:${sizeCq.toFixed(3)}cqw`].join(';');
    return `<p style="${style}">${bullet}${content}</p>`;
  }).join('');
  return html;
}

function anchorOf(txBody) { return { ctr: 'center', b: 'flex-end' }[attr(kid(txBody, 'bodyPr'), 'anchor')] || 'flex-start'; }
function insetsOf(txBody, slideW) {
  const b = kid(txBody, 'bodyPr'); const pct = (v, d) => `${((num(attr(b, v), d) / slideW) * 100).toFixed(3)}cqw`;
  return `${pct('tIns', 45720)} ${pct('rIns', 91440)} ${pct('bIns', 45720)} ${pct('lIns', 91440)}`;
}

// ---- one slide ----
function loadImage(zip, target, budget) {
  const mime = IMAGE_MIME[path.extname(target || '').toLowerCase()]; const file = target && zip.getEntry(target);
  if (!mime || !file || file.header.size > 8 * 1024 * 1024 || budget.left < file.header.size) return null;
  budget.left -= file.header.size;
  return `data:${mime};base64,${file.getData().toString('base64')}`;
}

function fillCss(spPr, ctx, rels, zip, budget) {
  if (!spPr) return '';
  if (kid(spPr, 'noFill')) return 'background:transparent;';
  const solid = colorOf(kid(spPr, 'solidFill'), ctx);
  if (solid) return `background:${solid};`;
  const grad = kid(spPr, 'gradFill');
  if (grad) { const stops = kids(kid(grad, 'gsLst'), 'gs').map((g) => `${colorOf(g, ctx) || '#888'} ${(num(attr(g, 'pos')) / 1000).toFixed(0)}%`); const lin = kid(grad, 'lin'); if (stops.length > 1) return `background:linear-gradient(${lin ? (num(attr(lin, 'ang')) / 60000 + 90).toFixed(0) : 180}deg,${stops.join(',')});`; if (stops.length) return `background:${stops[0].split(' ')[0]};`; }
  const blip = dig(spPr, 'blipFill', 'blip');
  if (blip) { const src = loadImage(zip, rels[attr(blip, 'r:embed')]?.target, budget); if (src) return `background:url('${src}') center/cover no-repeat;`; }
  return '';
}
function lineCss(spPr, ctx, slideW) {
  const ln = kid(spPr, 'ln'); if (!ln || kid(ln, 'noFill')) return '';
  const color = colorOf(kid(ln, 'solidFill'), ctx); if (!color) return '';
  const w = Math.max(num(attr(ln, 'w'), 12700), 6350);
  return `border:${((w / slideW) * 100).toFixed(3)}cqw solid ${color};box-sizing:border-box;`;
}

function boxCss(x, slideW, slideH) {
  const s = [`left:${(x.x / slideW * 100).toFixed(3)}%`, `top:${(x.y / slideH * 100).toFixed(3)}%`, `width:${(x.w / slideW * 100).toFixed(3)}%`, `height:${(x.h / slideH * 100).toFixed(3)}%`];
  const t = [x.rot ? `rotate(${x.rot}deg)` : '', x.flipH ? 'scaleX(-1)' : '', x.flipV ? 'scaleY(-1)' : ''].filter(Boolean).join(' ');
  if (t) s.push(`transform:${t}`);
  return s.join(';');
}

/** Draws the shapes of one tree (slide, layout or master). `skipPlaceholders` is used for the artwork behind a slide. */
function drawTree(tree, env, { skipPlaceholders, offset }) {
  const { zip, rels, ctx, slideW, slideH, budget, layoutTree, masterTree, masterStyles } = env;
  const out = [];
  const place = (x) => (offset ? { ...x, x: offset.x + (x.x - offset.chX) * offset.sx, y: offset.y + (x.y - offset.chY) * offset.sy, w: x.w * offset.sx, h: x.h * offset.sy } : x);
  for (const node of kids(tree)) {
    const name = node.localName;
    if (name === 'grpSp') {
      const gx = dig(node, 'grpSpPr', 'xfrm'); const g = xfrmOf(node);
      if (!g || !gx) continue;
      const chOff = kid(gx, 'chOff'); const chExt = kid(gx, 'chExt');
      const chW = num(attr(chExt, 'cx'), g.w) || g.w; const chH = num(attr(chExt, 'cy'), g.h) || g.h;
      const outer = place(g);
      out.push(...drawTree(node, env, { skipPlaceholders, offset: { x: outer.x, y: outer.y, chX: num(attr(chOff, 'x')), chY: num(attr(chOff, 'y')), sx: outer.w / chW, sy: outer.h / chH } }));
      continue;
    }
    if (!['sp', 'pic', 'graphicFrame', 'cxnSp'].includes(name)) continue;
    const ph = phOf(node);
    if (skipPlaceholders && ph) continue;
    let x = xfrmOf(node); let layoutSp = null; let masterSp = null;
    if (ph) { layoutSp = findPlaceholder(layoutTree, ph); masterSp = findPlaceholder(masterTree, ph); x = x || (layoutSp && xfrmOf(layoutSp)) || (masterSp && xfrmOf(masterSp)); }
    if (!x || x.w <= 0 && x.h <= 0) continue;
    x = place(x);
    const spPr = kid(node, 'spPr');
    const geom = attr(dig(spPr, 'prstGeom'), 'prst') || 'rect';
    const radius = geom === 'ellipse' ? 'border-radius:50%;' : /roundRect/.test(geom) ? 'border-radius:12%/20%;' : '';

    if (name === 'pic') {
      const blip = dig(node, 'blipFill', 'blip'); const src = blip && loadImage(zip, rels[attr(blip, 'r:embed')]?.target, budget);
      if (!src) continue;
      const crop = kid(dig(node, 'blipFill'), 'srcRect'); const [l, t, r, b] = ['l', 't', 'r', 'b'].map((k) => num(attr(crop, k)) / 100000);
      const kw = Math.max(0.05, 1 - l - r); const kh = Math.max(0.05, 1 - t - b);
      const descr = attr(dig(node, 'nvPicPr', 'cNvPr'), 'descr') || '';
      const alt = /[\\/]|\.(png|jpe?g|gif|webp|svg)$/i.test(descr) ? '' : descr.slice(0, 300); // some tools put the picture's file path there
      out.push(`<div class="sc-shape" style="${boxCss(x, slideW, slideH)};overflow:hidden;${radius}"><img src="${src}" alt="${esc(alt)}" draggable="false" style="position:absolute;left:${(-l / kw * 100).toFixed(3)}%;top:${(-t / kh * 100).toFixed(3)}%;width:${(100 / kw).toFixed(3)}%;height:${(100 / kh).toFixed(3)}%"></div>`);
      continue;
    }
    if (name === 'graphicFrame') {
      const tbl = node.getElementsByTagName('a:tbl')[0]; if (!tbl) continue;
      const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map((c) => num(attr(c, 'w')));
      const total = cols.reduce((a, b) => a + b, 0) || 1;
      const trs = kids(tbl, 'tr'); const rowTotal = trs.reduce((a, tr) => a + num(attr(tr, 'h'), 1), 0) || 1;
      const rows = trs.map((tr) => `<tr style="height:${(num(attr(tr, 'h'), 1) / rowTotal * 100).toFixed(2)}%">${kids(tr, 'tc').map((tc) => {
        const tcPr = kid(tc, 'tcPr'); const fill = colorOf(kid(tcPr, 'solidFill'), ctx);
        const text = renderText(kid(tc, 'txBody'), ctx, { chain: [], slideW, defaultSz: 1800 });
        return `<td style="${fill ? `background:${fill};` : ''}border:${(6350 / slideW * 100).toFixed(3)}cqw solid #c9ccd3;padding:${(45720 / slideW * 100).toFixed(2)}cqw ${(91440 / slideW * 100).toFixed(2)}cqw;vertical-align:middle">${text}</td>`;
      }).join('')}</tr>`).join('');
      out.push(`<div class="sc-shape" style="${boxCss(x, slideW, slideH)}"><table style="width:100%;border-collapse:collapse;table-layout:fixed;color:#1c2233"><colgroup>${cols.map((c) => `<col style="width:${(c / total * 100).toFixed(2)}%">`).join('')}</colgroup>${rows}</table></div>`);
      continue;
    }
    if (name === 'cxnSp') {
      // a straight connector: one edge of its box, in the line's own colour and width
      const ln = kid(spPr, 'ln'); const colour = colorOf(kid(ln, 'solidFill'), ctx) || '#444444';
      const width = `${(Math.max(num(attr(ln, 'w'), 12700), 6350) / slideW * 100).toFixed(3)}cqw`;
      const edge = x.h < x.w ? 'border-top' : 'border-left';
      out.push(`<div class="sc-shape" style="${boxCss(x, slideW, slideH)};${edge}:${width} solid ${colour}"></div>`);
      continue;
    }
    // an ordinary shape / text box / placeholder
    const txBody = kid(node, 'txBody');
    const chain = ph ? [layoutSp && kid(kid(layoutSp, 'txBody'), 'lstStyle'), masterSp && kid(kid(masterSp, 'txBody'), 'lstStyle'), masterStyles[TX_STYLE[normType(attr(ph, 'type'))] || 'otherStyle']] : [masterStyles.otherStyle];
    let fill = fillCss(spPr, ctx, rels, zip, budget); let line = lineCss(spPr, ctx, slideW);
    if (ph && !fill && layoutSp) fill = fillCss(kid(layoutSp, 'spPr'), ctx, env.layoutRels, zip, budget);
    const hasText = txBody && Array.from(txBody.getElementsByTagName('a:t')).some((t) => t.textContent.trim());
    if (!fill && !line && !hasText) continue;
    // a shape's own text takes its colour from the shape style (fontRef) when it has no colour of its own
    const fontRefColor = colorOf(dig(node, 'style', 'fontRef'), ctx);
    const textHtml = hasText ? renderText(txBody, { ...ctx, fontRefColor }, { chain, slideW, defaultSz: 1800 }) : '';
    const inner = hasText ? `<div style="display:flex;flex-direction:column;justify-content:${anchorOf(txBody)};height:100%;padding:${insetsOf(txBody, slideW)};box-sizing:border-box;color:${fontRefColor || '#1c2233'}">${textHtml}</div>` : '';
    out.push(`<div class="sc-shape" style="${boxCss(x, slideW, slideH)};${fill}${line}${radius}">${inner}</div>`);
  }
  return out;
}

function backgroundCss(zip, bgHolders, ctx, budget) {
  for (const { doc, rels } of bgHolders) {
    const bg = doc && dig(dig(doc, 'cSld'), 'bg');
    if (!bg) continue;
    const pr = kid(bg, 'bgPr');
    if (pr) { const css = fillCss(pr, ctx, rels, zip, budget); if (css) return css; }
    const ref = kid(bg, 'bgRef'); const c = ref && colorOf(ref, ctx); if (c) return `background:${c};`;
  }
  return 'background:#ffffff;';
}

/** The slides of a .pptx as positioned HTML: [{ number, html }] or null when the file cannot be read. */
function renderPptx(storagePath) {
  try {
    const zip = new AdmZip(resolveStoragePath(storagePath));
    const entries = zip.getEntries();
    if (entries.reduce((n, e) => n + e.header.size, 0) > MAX_DECK) return null;
    const presEntry = zip.getEntry('ppt/presentation.xml'); if (!presEntry) return null;
    const pres = parse(presEntry.getData().toString('utf8')).documentElement;
    const sz = kid(pres, 'sldSz'); const slideW = num(attr(sz, 'cx'), 9144000); const slideH = num(attr(sz, 'cy'), 6858000);
    const presRels = relsOf(zip, 'ppt/presentation.xml');
    let order = kids(kid(pres, 'sldIdLst'), 'sldId').map((s) => presRels[s.getAttribute('r:id')]?.target).filter(Boolean);
    if (!order.length) order = entries.map((e) => e.entryName).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a.match(/(\d+)\.xml/)[1]) - num(b.match(/(\d+)\.xml/)[1]));
    const budget = { left: 24 * 1024 * 1024 };
    const slides = [];
    const cache = {};
    const load = (p) => (cache[p] = cache[p] || parse(zip.getEntry(p).getData().toString('utf8')).documentElement);
    for (const [i, slidePath] of order.entries()) {
      if (!zip.getEntry(slidePath)) continue;
      const slide = load(slidePath); const rels = relsOf(zip, slidePath);
      const layoutPath = Object.values(rels).find((r) => r.type === 'slideLayout')?.target;
      const layout = layoutPath && zip.getEntry(layoutPath) ? load(layoutPath) : null; const layoutRels = layout ? relsOf(zip, layoutPath) : {};
      const masterPath = layout && Object.values(layoutRels).find((r) => r.type === 'slideMaster')?.target;
      const master = masterPath && zip.getEntry(masterPath) ? load(masterPath) : null; const masterRels = master ? relsOf(zip, masterPath) : {};
      const ctx = { theme: readTheme(zip, masterPath || ''), clrMap: master ? clrMapOf(master) : {} };
      const tx = master && kid(master, 'txStyles');
      const masterStyles = { titleStyle: kid(tx, 'titleStyle'), bodyStyle: kid(tx, 'bodyStyle'), otherStyle: kid(tx, 'otherStyle') };
      const tree = (d) => dig(dig(d, 'cSld'), 'spTree');
      const env = { zip, rels, layoutRels, ctx, slideW, slideH, budget, layoutTree: layout && tree(layout), masterTree: master && tree(master), masterStyles };
      const parts = [];
      const bg = backgroundCss(zip, [{ doc: slide, rels }, { doc: layout, rels: layoutRels }, { doc: master, rels: masterRels }], ctx, budget);
      if (master && attr(layout, 'showMasterSp') !== '0' && attr(slide, 'showMasterSp') !== '0') parts.push(...drawTree(tree(master), { ...env, rels: masterRels }, { skipPlaceholders: true }));
      if (layout && attr(slide, 'showMasterSp') !== '0') parts.push(...drawTree(tree(layout), { ...env, rels: layoutRels }, { skipPlaceholders: true }));
      parts.push(...drawTree(tree(slide), env, { skipPlaceholders: false }));
      slides.push({ number: i + 1, html: `<div class="sc-canvas" style="aspect-ratio:${slideW} / ${slideH};${bg}">${parts.join('')}</div>` });
    }
    return slides.length ? slides : null;
  } catch { return null; }
}

module.exports = { renderPptx };

