'use strict';
/*
 * Minimal .xlsx reader (zero dependencies). Reads cell values (cached formula results included)
 * from every sheet. Enough for importing the Direbattle Cup dashboard workbooks.
 *
 *   const { readXlsx } = require('./xlsx');
 *   const book = readXlsx(buffer);   // { "Sheet name": [[row0col0, row0col1, ...], ...], ... }
 */
const zlib = require('zlib');

function unzip(buf) {
  // find End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt .xlsx (central directory)');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    const lnameLen = buf.readUInt16LE(local + 26), lextraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lnameLen + lextraLen;
    const data = buf.slice(start, start + csize);
    files[name] = () => (method === 0 ? data : zlib.inflateRawSync(data));
  }
  return files;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e.toLowerCase()];
});
const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? unxml(m[1]) : null; };
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

function readXlsx(buf) {
  const files = unzip(buf);
  const text = (name) => (files[name] ? files[name]().toString('utf8') : '');

  const shared = [];
  for (const si of text('xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) || []) {
    shared.push((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => unxml(t.replace(/<t[^>]*>|<\/t>/g, ''))).join(''));
  }

  const rels = {};
  for (const r of text('xl/_rels/workbook.xml.rels').match(/<Relationship\b[^>]*>/g) || []) rels[attr(r, 'Id')] = attr(r, 'Target');

  const book = {};
  for (const s of text('xl/workbook.xml').match(/<sheet\b[^>]*>/g) || []) {
    const name = attr(s, 'name');
    let target = rels[attr(s, 'r:id')] || '';
    target = target.replace(/^\//, '');
    if (!target.startsWith('xl/')) target = 'xl/' + target;
    const xml = text(target);
    const rows = [];
    for (const row of xml.match(/<row\b[^>]*\/>|<row\b[^>]*[^/]>[\s\S]*?<\/row>/g) || []) {
      const r = Number(attr(row, 'r')) - 1;
      const cells = [];
      for (const c of row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
        const open = c.match(/<c\b[^>]*>/)[0];
        const ref = attr(open, 'r');
        const t = attr(open, 't');
        const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = null;
        if (t === 's') val = v != null ? shared[Number(v)] : null;
        else if (t === 'inlineStr') val = (c.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((x) => unxml(x.replace(/<t[^>]*>|<\/t>/g, ''))).join('');
        else if (t === 'str' || t === 'e') val = v != null ? unxml(v) : null;
        else if (t === 'b') val = v === '1';
        else if (v != null) val = Number(v);
        cells[colIndex(ref)] = val;
      }
      rows[r] = cells;
    }
    book[name] = Array.from(rows, (r) => r || []);
  }
  return book;
}

module.exports = { readXlsx };
