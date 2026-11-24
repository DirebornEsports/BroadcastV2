'use strict';
// A tiny synchronous "fs" for the server code, backed by the Durable Object's storage.
//   /app/data/*, /app/state.json, /app/cache/*   -> read/write, stored as text (split into chunks when large)
//   /app/config.json, /app/seed/*                 -> read-only, bundled with the Worker
//   /app/public/logos/uploads/*                   -> R2 (writes are sent in the background)
//   readdir of /app/public/...                    -> the file list made at build time (src/generated/manifest.json)
const ROOT = '/app';
const CHUNK = 400000;                 // characters per stored row (a row holds at most 2 MB)

function enoent(file) { const e = new Error('ENOENT: no such file ' + file); e.code = 'ENOENT'; return e; }
function rel(file) {
  const p = String(file).replace(/\\/g, '/');
  if (!p.startsWith(ROOT + '/')) throw new Error('Path outside the app: ' + file);
  const parts = [];
  for (const seg of p.slice(ROOT.length + 1).split('/')) { if (!seg || seg === '.') continue; if (seg === '..') parts.pop(); else parts.push(seg); }
  return parts.join('/');
}
const toText = (d) => (typeof d === 'string' ? d : Buffer.isBuffer(d) || d instanceof Uint8Array ? Buffer.from(d).toString('utf8') : String(d));

/**
 * kv: { get(key) -> string|undefined, put(key, string), delete(key), keys(prefix) -> string[] }  (synchronous)
 * bundle: { 'config.json': text, 'seed/x.json': text, ... }   manifest: { 'public/sounds': [names], ... }
 * blobs: { put(key, bytes, type) -> Promise, delete(key) -> Promise }   (R2, optional)
 */
function createFs({ kv, bundle = {}, manifest = {}, blobs = null }) {
  const isUpload = (r) => r.startsWith('public/logos/uploads/');
  const isWritable = (r) => r === 'state.json' || r.startsWith('data/') || r.startsWith('cache/') || (!blobs && r.startsWith('public/logos/uploads/'));
  function getText(r) {
    if (Object.prototype.hasOwnProperty.call(bundle, r)) return bundle[r];
    if (!isWritable(r)) return undefined;
    const v = kv.get('f:' + r);
    if (v === undefined || v === null) return undefined;
    if (v.startsWith('\u0000chunks:')) {
      const n = Number(v.slice(8));
      let out = '';
      for (let i = 0; i < n; i++) out += kv.get(`c:${r}:${i}`) || '';
      return out;
    }
    return v;
  }
  function putText(r, text) {
    const old = kv.get('f:' + r);
    const oldN = old && old.startsWith('\u0000chunks:') ? Number(old.slice(8)) : 0;
    if (text.length <= CHUNK) {
      kv.put('f:' + r, text);
      for (let i = 0; i < oldN; i++) kv.delete(`c:${r}:${i}`);
      return;
    }
    const n = Math.ceil(text.length / CHUNK);
    for (let i = 0; i < n; i++) kv.put(`c:${r}:${i}`, text.slice(i * CHUNK, (i + 1) * CHUNK));
    for (let i = n; i < oldN; i++) kv.delete(`c:${r}:${i}`);
    kv.put('f:' + r, '\u0000chunks:' + n);
  }
  function del(r) {
    const old = kv.get('f:' + r);
    if (old && old.startsWith('\u0000chunks:')) for (let i = 0; i < Number(old.slice(8)); i++) kv.delete(`c:${r}:${i}`);
    kv.delete('f:' + r);
  }
  const background = (p) => { if (p && p.catch) p.catch((e) => console.error('R2:', e.message)); };

  const fs = {
    readFileSync(file, enc) {
      const r = rel(file);
      const t = getText(r);
      if (t === undefined) throw enoent(file);
      return enc ? t : Buffer.from(t, 'utf8');
    },
    writeFileSync(file, data) {
      const r = rel(file);
      if (isUpload(r)) {
        if (blobs) background(blobs.put(r.slice('public/logos/'.length), data));
        else putText(r, Buffer.from(typeof data === 'string' ? Buffer.from(data) : data).toString('base64'));   // no R2: keep it in the Durable Object
        return;
      }
      if (!isWritable(r)) throw new Error('Read-only file: ' + r);
      putText(r, toText(data));
    },
    existsSync(file) {
      const r = rel(file);
      if (Object.prototype.hasOwnProperty.call(bundle, r) || Object.prototype.hasOwnProperty.call(manifest, r)) return true;
      if (!isWritable(r)) return false;
      if (kv.get('f:' + r) !== undefined) return true;
      return kv.keys('f:' + r + '/').length > 0;
    },
    mkdirSync() {},
    copyFileSync(a, b) { fs.writeFileSync(b, fs.readFileSync(a, 'utf8')); },
    renameSync(a, b) {
      const ra = rel(a);
      const t = getText(ra);
      if (t === undefined) throw enoent(a);
      putText(rel(b), t); del(ra);
    },
    unlinkSync(file) {
      const r = rel(file);
      if (isUpload(r)) { if (blobs) background(blobs.delete(r.slice('public/logos/'.length))); else del(r); return; }
      del(r);
    },
    readdirSync(dir) {
      const r = rel(dir);
      if (manifest[r]) return [...manifest[r]];
      const pre = 'f:' + (r ? r + '/' : '');
      const names = new Set(kv.keys(pre).map((k) => k.slice(pre.length).split('/')[0]));
      if (!names.size) throw enoent(dir);
      return [...names];
    },
  };
  // an upload kept in the Durable Object (when there is no R2 bucket): bytes or null
  fs.readUpload = (name) => {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return null;
    const t = getText('public/logos/uploads/' + name);
    return t === undefined ? null : Buffer.from(t, 'base64');
  };
  fs.promises = {
    writeFile: async (f, d) => fs.writeFileSync(f, d),
    readFile: async (f, enc) => fs.readFileSync(f, enc),
    mkdir: async () => {},
    rename: async (a, b) => fs.renameSync(a, b),
    unlink: async (f) => fs.unlinkSync(f),
    readdir: async (d) => fs.readdirSync(d),
    stat: async (f) => { if (!fs.existsSync(f)) throw enoent(f); return { isFile: () => true, size: 0 }; },
  };
  return fs;
}

// key/value store over the Durable Object's SQLite database (synchronous)
function sqlKv(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  return {
    get(k) { const rows = sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray(); return rows.length ? rows[0].v : undefined; },
    put(k, v) { sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', k, v); },
    delete(k) { sql.exec('DELETE FROM kv WHERE k = ?', k); },
    keys(prefix) { return sql.exec('SELECT k FROM kv WHERE k >= ? AND k < ?', prefix, prefix + '￿').toArray().map((r) => r.k); },
  };
}
// the same interface in memory (local tests)
function memoryKv(map = new Map()) {
  return {
    get: (k) => map.get(k), put: (k, v) => { map.set(k, String(v)); }, delete: (k) => { map.delete(k); },
    keys: (prefix) => [...map.keys()].filter((k) => k.startsWith(prefix)),
    map,
  };
}

module.exports = { createFs, sqlKv, memoryKv };
