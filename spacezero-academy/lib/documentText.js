'use strict';
const path = require('node:path');
async function documentText(filename) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.docx') return (await require('mammoth').extractRawText({ path: filename })).value;
  if (extension === '.pptx') {
    const zip = new (require('adm-zip'))(filename);
    const slides = zip.getEntries().filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName)).sort((a,b) => Number(a.entryName.match(/slide(\d+)/)[1]) - Number(b.entryName.match(/slide(\d+)/)[1]));
    if (slides.reduce((n,e) => n + e.header.size, 0) > 20 * 1024 * 1024) throw new Error('Slides contain too much uncompressed text.');
    return slides.map(e => `Slide ${e.entryName.match(/slide(\d+)/)[1]}:\n${[...e.getData().toString('utf8').matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map(m => m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"')).join('\n')}`).join('\n\n');
  }
  if (['.txt', '.md', '.html', '.htm', '.rtf', '.odt', '.xlsx', '.ods', '.csv', '.tsv', '.epub'].includes(extension)) return require('./documentRender').plainText(filename);
  if (['.doc','.ppt'].includes(extension)) throw new Error('Convert legacy DOC/PPT material to DOCX/PPTX or PDF before analysis.');
  return null;
}
module.exports = { documentText };
