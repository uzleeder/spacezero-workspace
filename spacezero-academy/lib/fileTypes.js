'use strict';

// Every kind of file a training can carry. Each one is something the app can SHOW inside the page (nothing is offered that a
// learner could not look at): audio and video play, pictures and vectors are shown, documents / e-books / presentations /
// spreadsheets / fonts / CAD drawings are drawn on the reading page. The file's real content is checked, not just its name.
//
//   category      extensions
//   Audio         mp3 wav ogg oga opus m4a aac flac weba
//   Video         mp4 m4v mov webm ogv
//   Image         png jpg jpeg gif webp bmp avif
//   Vector        svg ai (PDF-based Illustrator files)
//   Document      pdf docx odt rtf txt md html htm   (old .doc is accepted but cannot be drawn: see lib/sourceFiles.js)
//   Ebook         epub
//   Presentation  pptx odp                            (old .ppt is accepted but cannot be drawn)
//   Spreadsheet   xlsx ods csv tsv
//   Font          ttf otf woff woff2
//   CAD           dxf
//
// contentType is the existing ModuleContentType the material is stored as (no database change): audio / video / images keep
// theirs, presentations are PPT, vector pictures are IMAGE, PDF-based vector files are PDF and everything else that is read is DOC.
const path = require('node:path');

const text = (sample) => sample.length > 0 && !sample.subarray(0, 8192).includes(0);
const head = (sample, n) => sample.subarray(0, n);
const ascii = (sample, from, to) => sample.subarray(from, to).toString('latin1');
const hex = (sample, n) => sample.subarray(0, n).toString('hex');
const has = (sample, needle) => sample.includes(Buffer.from(needle));
const zip = (sample) => hex(sample, 4) === '504b0304';
const ftyp = (sample) => ascii(sample, 4, 8) === 'ftyp';
const odf = (kind) => (s) => zip(s) && has(head(s, 2048), `application/vnd.oasis.opendocument.${kind}`);
const mp3 = (s) => ascii(s, 0, 3) === 'ID3' || (s[0] === 0xff && (s[1] & 0xe0) === 0xe0);

const TYPES = [
  // ---- Audio ----
  { ext: '.mp3', category: 'Audio', contentType: 'AUDIO', mime: 'audio/mpeg', check: mp3 },
  { ext: '.wav', category: 'Audio', contentType: 'AUDIO', mime: 'audio/wav', check: (s) => ascii(s, 0, 4) === 'RIFF' && ascii(s, 8, 12) === 'WAVE' },
  { ext: '.ogg', category: 'Audio', contentType: 'AUDIO', mime: 'audio/ogg', check: (s) => ascii(s, 0, 4) === 'OggS' },
  { ext: '.oga', category: 'Audio', contentType: 'AUDIO', mime: 'audio/ogg', check: (s) => ascii(s, 0, 4) === 'OggS' },
  { ext: '.opus', category: 'Audio', contentType: 'AUDIO', mime: 'audio/ogg', check: (s) => ascii(s, 0, 4) === 'OggS' },
  { ext: '.m4a', category: 'Audio', contentType: 'AUDIO', mime: 'audio/mp4', check: ftyp },
  { ext: '.aac', category: 'Audio', contentType: 'AUDIO', mime: 'audio/aac', check: (s) => ascii(s, 0, 3) === 'ID3' || (s[0] === 0xff && (s[1] & 0xf6) === 0xf0) },
  { ext: '.flac', category: 'Audio', contentType: 'AUDIO', mime: 'audio/flac', check: (s) => ascii(s, 0, 4) === 'fLaC' },
  { ext: '.weba', category: 'Audio', contentType: 'AUDIO', mime: 'audio/webm', check: (s) => hex(s, 4) === '1a45dfa3' },
  // ---- Video ----
  { ext: '.mp4', category: 'Video', contentType: 'VIDEO', mime: 'video/mp4', check: ftyp },
  { ext: '.m4v', category: 'Video', contentType: 'VIDEO', mime: 'video/mp4', check: ftyp },
  { ext: '.mov', category: 'Video', contentType: 'VIDEO', mime: 'video/quicktime', check: (s) => ['ftyp', 'moov', 'mdat', 'wide', 'free'].includes(ascii(s, 4, 8)) },
  { ext: '.webm', category: 'Video', contentType: 'VIDEO', mime: 'video/webm', check: (s) => hex(s, 4) === '1a45dfa3' },
  { ext: '.ogv', category: 'Video', contentType: 'VIDEO', mime: 'video/ogg', check: (s) => ascii(s, 0, 4) === 'OggS' },
  // ---- Image ----
  { ext: '.png', category: 'Image', contentType: 'IMAGE', mime: 'image/png', check: (s) => hex(s, 8) === '89504e470d0a1a0a' },
  { ext: '.jpg', category: 'Image', contentType: 'IMAGE', mime: 'image/jpeg', check: (s) => hex(s, 3) === 'ffd8ff' },
  { ext: '.jpeg', category: 'Image', contentType: 'IMAGE', mime: 'image/jpeg', check: (s) => hex(s, 3) === 'ffd8ff' },
  { ext: '.gif', category: 'Image', contentType: 'IMAGE', mime: 'image/gif', check: (s) => ['GIF87a', 'GIF89a'].includes(ascii(s, 0, 6)) },
  { ext: '.webp', category: 'Image', contentType: 'IMAGE', mime: 'image/webp', check: (s) => ascii(s, 0, 4) === 'RIFF' && ascii(s, 8, 12) === 'WEBP' },
  { ext: '.bmp', category: 'Image', contentType: 'IMAGE', mime: 'image/bmp', check: (s) => ascii(s, 0, 2) === 'BM' },
  { ext: '.avif', category: 'Image', contentType: 'IMAGE', mime: 'image/avif', check: (s) => ftyp(s) && has(head(s, 64), 'avif') },
  // ---- Vector ----
  { ext: '.svg', category: 'Vector', contentType: 'IMAGE', mime: 'image/svg+xml', check: (s) => text(s) && /<svg[\s>]/i.test(head(s, 4096).toString('utf8')) },
  { ext: '.ai', category: 'Vector', contentType: 'PDF', mime: 'application/pdf', check: (s) => ascii(s, 0, 5) === '%PDF-' },
  // ---- Document ----
  { ext: '.pdf', category: 'Document', contentType: 'PDF', mime: 'application/pdf', check: (s) => ascii(s, 0, 5) === '%PDF-' },
  { ext: '.docx', category: 'Document', contentType: 'DOC', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', check: (s) => zip(s) && has(s, 'word/') },
  { ext: '.odt', category: 'Document', contentType: 'DOC', mime: 'application/vnd.oasis.opendocument.text', check: odf('text') },
  { ext: '.rtf', category: 'Document', contentType: 'DOC', mime: 'application/rtf', check: (s) => ascii(s, 0, 5) === '{\\rtf' },
  { ext: '.txt', category: 'Document', contentType: 'DOC', mime: 'text/plain', check: text },
  { ext: '.md', category: 'Document', contentType: 'DOC', mime: 'text/markdown', check: text },
  { ext: '.html', category: 'Document', contentType: 'DOC', mime: 'text/html', check: (s) => text(s) && has(head(s, 8192), '<') },
  { ext: '.htm', category: 'Document', contentType: 'DOC', mime: 'text/html', check: (s) => text(s) && has(head(s, 8192), '<') },
  // ---- Ebook ----
  { ext: '.epub', category: 'Ebook', contentType: 'DOC', mime: 'application/epub+zip', check: (s) => zip(s) && has(head(s, 2048), 'application/epub+zip') },
  // ---- Presentation ----
  { ext: '.pptx', category: 'Presentation', contentType: 'PPT', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', check: (s) => zip(s) && has(s, 'ppt/') },
  { ext: '.odp', category: 'Presentation', contentType: 'PPT', mime: 'application/vnd.oasis.opendocument.presentation', check: odf('presentation') },
  // ---- Spreadsheet ----
  { ext: '.xlsx', category: 'Spreadsheet', contentType: 'DOC', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', check: (s) => zip(s) && has(s, 'xl/') },
  { ext: '.ods', category: 'Spreadsheet', contentType: 'DOC', mime: 'application/vnd.oasis.opendocument.spreadsheet', check: odf('spreadsheet') },
  { ext: '.csv', category: 'Spreadsheet', contentType: 'DOC', mime: 'text/csv', check: text },
  { ext: '.tsv', category: 'Spreadsheet', contentType: 'DOC', mime: 'text/tab-separated-values', check: text },
  // ---- Font ----
  { ext: '.ttf', category: 'Font', contentType: 'DOC', mime: 'font/ttf', check: (s) => ['00010000', '74727565', '74746366'].includes(hex(s, 4)) },
  { ext: '.otf', category: 'Font', contentType: 'DOC', mime: 'font/otf', check: (s) => ascii(s, 0, 4) === 'OTTO' || hex(s, 4) === '00010000' },
  { ext: '.woff', category: 'Font', contentType: 'DOC', mime: 'font/woff', check: (s) => ascii(s, 0, 4) === 'wOFF' },
  { ext: '.woff2', category: 'Font', contentType: 'DOC', mime: 'font/woff2', check: (s) => ascii(s, 0, 4) === 'wOF2' },
  // ---- CAD ----
  { ext: '.dxf', category: 'CAD', contentType: 'DOC', mime: 'image/vnd.dxf', check: (s) => text(s) && /SECTION/.test(head(s, 8192).toString('utf8')) },
];
const BY_EXT = new Map(TYPES.map((t) => [t.ext, t]));

/** Formats that exist but cannot be shown inside a page: refused with a hint for what to upload instead. */
const CANNOT_SHOW = {
  '.dwg': 'a DWG drawing cannot be shown in the browser - export it as DXF or PDF', '.mobi': 'a MOBI e-book cannot be shown - convert it to EPUB or PDF', '.azw3': 'an AZW3 e-book cannot be shown - convert it to EPUB or PDF',
  '.eps': 'an EPS file cannot be shown - export it as SVG or PDF', '.tif': 'a TIFF picture cannot be shown in the browser - save it as PNG or JPG', '.tiff': 'a TIFF picture cannot be shown in the browser - save it as PNG or JPG',
  '.heic': 'a HEIC picture cannot be shown in most browsers - save it as JPG or PNG', '.heif': 'a HEIF picture cannot be shown in most browsers - save it as JPG or PNG',
  '.avi': 'an AVI video cannot be played in the browser - convert it to MP4', '.mkv': 'an MKV video does not play in every browser - convert it to MP4', '.wmv': 'a WMV video cannot be played in the browser - convert it to MP4', '.flv': 'an FLV video cannot be played in the browser - convert it to MP4',
  '.xls': 'an old XLS spreadsheet cannot be shown - save it as XLSX or CSV', '.xlsm': 'a macro spreadsheet cannot be shown - save it as XLSX', '.key': 'a Keynote file cannot be shown - export it as PDF or PPTX', '.numbers': 'a Numbers file cannot be shown - export it as XLSX or CSV', '.pages': 'a Pages file cannot be shown - export it as PDF or DOCX',
  '.wma': 'a WMA recording cannot be played in the browser - convert it to MP3', '.aiff': 'an AIFF recording cannot be played in the browser - convert it to WAV or MP3',
};

const lookup = (filename) => BY_EXT.get(path.extname(String(filename || '')).toLowerCase()) || null;
const hint = (filename) => CANNOT_SHOW[path.extname(String(filename || '')).toLowerCase()] || null;

/** Checks the real content of an uploaded file of a known type; returns an error message or null. `sample` = its first / last bytes. */
function validateContent(entry, file, sample) {
  if (!file || !file.size) return 'The file is empty.';
  if (!entry.check(sample)) return `${file.originalname || 'The file'} is not a real ${entry.ext.slice(1).toUpperCase()} file (its content does not match).`;
  return null;
}

const CATEGORY_NOUN = { Audio: 'the recording', Video: 'the video', Image: 'the image', Vector: 'the drawing', Document: 'the document', Ebook: 'the e-book', Presentation: 'the slides', Spreadsheet: 'the spreadsheet', Font: 'the font', CAD: 'the drawing' };
const nounFor = (filename) => { const t = lookup(filename); return t ? CATEGORY_NOUN[t.category] : 'the document'; };

const ALL_EXTENSIONS = TYPES.map((t) => t.ext);
const CATEGORIES = [...new Set(TYPES.map((t) => t.category))];

module.exports = { TYPES, lookup, hint, validateContent, nounFor, ALL_EXTENSIONS, CATEGORIES, CANNOT_SHOW };
