// Runs the Cloudflare Worker on your own PC with Node (no Cloudflare account needed) — for testing.
//   node dev/local.mjs            → http://localhost:8787   (state kept in dev/.data/)
//   npm run lan                   → the venue's own network: player cams through a local SFU (dev/localsfu.mjs)
//                                   instead of Cloudflare Realtime, plus https on :8443 (browsers only open a camera
//                                   on https; self-signed, so each PC clicks "Advanced → Proceed" once)
// Emulates: static assets (public/), the Durable Object's SQLite storage, the R2 bucket.
// Secrets come from dev/.dev.json (copy dev/dev.example.json) or the environment.
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
const DATA = process.env.DEV_DATA || path.join(ROOT, 'dev/.data');
const PERSIST = process.env.DEV_PERSIST !== '0';
const LAN = process.env.LAN === '1' || process.argv.includes('--lan'), HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const worker = await import(pathToFileURL(path.join(ROOT, 'src/worker.mjs')).href);   // a file URL: a bare C:\ path fails on Windows

// ---------- secrets ----------
let secrets = {};
for (const f of ['dev/.dev.json', 'dev/dev.example.json']) { try { secrets = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); break; } catch {} }
for (const k of ['ADMIN_PASSWORD', 'GSI_TOKEN', 'CF_APP_ID', 'CF_APP_SECRET', 'PUSH_KEY', 'VIEW_KEY', 'TURN_KEY_ID', 'TURN_KEY_TOKEN', 'LOCAL_ADMIN']) if (process.env[k] !== undefined) secrets[k] = process.env[k];

// ---------- Durable Object SQLite (only the statements src/vfs.js uses) ----------
fs.mkdirSync(DATA, { recursive: true });
const DB_FILE = path.join(DATA, 'kv.json');
const table = new Map(PERSIST ? Object.entries((() => { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; } })()) : []);
let saveT = null;
const persist = () => { if (!PERSIST) return; clearTimeout(saveT); saveT = setTimeout(() => fs.writeFileSync(DB_FILE, JSON.stringify(Object.fromEntries(table))), 300); };
const sql = {
  exec(q, ...a) {
    const rows = (r) => ({ toArray: () => r, one: () => r[0] });
    q = q.trim();
    if (/^CREATE TABLE/i.test(q)) return rows([]);
    if (/^SELECT v FROM kv WHERE k = \?$/i.test(q)) return rows(table.has(a[0]) ? [{ v: table.get(a[0]) }] : []);
    if (/^INSERT OR REPLACE INTO kv/i.test(q)) { if (String(a[1]).length > 2e6) throw new Error('SQLITE_TOOBIG'); table.set(a[0], String(a[1])); persist(); return rows([]); }
    if (/^DELETE FROM kv WHERE k = \?$/i.test(q)) { table.delete(a[0]); persist(); return rows([]); }
    if (/^SELECT k FROM kv WHERE k >= \? AND k < \?$/i.test(q)) return rows([...table.keys()].filter((k) => k >= a[0] && k < a[1]).sort().map((k) => ({ k })));
    throw new Error('dev sql: unsupported statement ' + q);
  },
};

// ---------- R2 ----------
const R2_DIR = path.join(DATA, 'r2');
const r2 = {
  async put(key, data, opts) { const f = path.join(R2_DIR, key); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data)); fs.writeFileSync(f + '.type', (opts && opts.httpMetadata && opts.httpMetadata.contentType) || ''); },
  async get(key) { const f = path.join(R2_DIR, key); if (!fs.existsSync(f)) return null; return { body: fs.readFileSync(f), httpMetadata: { contentType: fs.existsSync(f + '.type') ? fs.readFileSync(f + '.type', 'utf8') : '' } }; },
  async delete(key) { try { fs.unlinkSync(path.join(R2_DIR, key)); } catch {} },
};

// ---------- static assets (html_handling: auto-trailing-slash) ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.webm': 'video/webm', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const PUB = path.join(ROOT, 'public');
const EMPTY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');   // 1x1, fully transparent (checked: RGBA 0 0 0 0)
const ASSETS = {
  async fetch(req) {
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname);
    // Broadcast 2.0 phases 0-3 (barebone): decorative art (frames, clouds, theme cut-outs) becomes an empty
    // image; content stays (hero portraits, team logos, player photos). BAREBONE=0 turns this off.
    if (process.env.BAREBONE !== '0' && /^\/(assets|themes)\/.*\.(png|jpe?g|webp|svg|gif)$/i.test(p) && !/\/direborn-(logo|mark)/.test(p)) return new Response(EMPTY_PNG, { headers: { 'content-type': 'image/png' } });
    const cands = p.endsWith('/') ? [p + 'index.html'] : [p, p + '.html'];
    for (const c of cands) {
      const f = path.normalize(path.join(PUB, c));
      if (f.startsWith(PUB) && fs.existsSync(f) && fs.statSync(f).isFile()) return new Response(fs.readFileSync(f), { headers: { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' } });
    }
    return new Response('Not found', { status: 404 });
  },
};

// ---------- the Durable Object namespace (one instance) ----------
let hub = null;
const env = { ...secrets, ASSETS, ...(process.env.DEV_NO_R2 === '1' ? {} : { UPLOADS: r2 }) };   // DEV_NO_R2=1: like an account without R2
env.HUB = { idFromName: (n) => n, get: () => ({ fetch: (req) => (hub ||= new worker.Hub({ storage: { sql } }, env)).fetch(req) }) };
globalThis.__devRestartHub = () => { hub = null; };          // tests: simulate Cloudflare restarting the Durable Object
let localSfu = null;
if (LAN) {
  ({ localSfu } = await import('./localsfu.mjs'));
  Object.assign(env, { SFU_URL: `http://127.0.0.1:${PORT}/v1`, CF_APP_ID: 'local', CF_APP_SECRET: 'local' });
}

// ---------- HTTP ----------
async function onRequest(req, res) {
  try {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    // the local SFU only answers this PC (the cam relay calls it over loopback)
    if (localSfu && req.url.startsWith('/v1/apps/') && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      let b = null; try { b = body.length ? JSON.parse(body) : null; } catch {}
      const [status, out] = await localSfu(req.method, req.url.replace(/^\/v1\/apps\/[^/]+/, ''), b);
      res.writeHead(status, { 'content-type': 'application/json' }); return res.end(JSON.stringify(out));
    }
    // the address the browser used (LAN IP, https), so redirects and cookies stay on it
    const headers = { ...req.headers };
    delete headers['x-dbo-local'];   // never trusted from outside: set below for this PC only (LOCAL_ADMIN in worker.mjs)
    if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) headers['x-dbo-local'] = '1';
    const request = new Request(`${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host || 'localhost:' + PORT}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const r = await worker.default.fetch(request, env, { waitUntil() {} });
    const h = {}; r.headers.forEach((v, k) => { if (k === 'set-cookie') (h[k] ||= []).push(v); else h[k] = v; });
    res.writeHead(r.status, h);
    if (!r.body) return res.end();
    const reader = r.body.getReader();
    req.on('close', () => { reader.cancel().catch(() => {}); });
    for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
    res.end();
  } catch (e) { console.error(e); try { res.writeHead(500); res.end('dev server error'); } catch {} }
}
const server = http.createServer(onRequest);
server.listen(PORT, () => {
  console.log(`\n  Direborn broadcast (local Cloudflare emulator) — http://localhost:${PORT}/control`);
  console.log(`  Data: ${PERSIST ? DATA : '(memory only)'}   Secrets: ${Object.keys(secrets).filter((k) => secrets[k]).join(', ') || '(none)'}\n`);
});
if (LAN) {
  const ips = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  // one certificate kept in the data folder (a new one each start would make every PC click through again)
  const CERT = path.join(DATA, 'lan-cert.json');
  let pems = null; try { pems = JSON.parse(fs.readFileSync(CERT, 'utf8')); if (pems.ips !== String(ips)) pems = null; } catch {}
  if (!pems) {
    const { generate } = await import('selfsigned');
    const g = await generate([{ name: 'commonName', value: 'direborn-broadcast.local' }], { keySize: 2048, algorithm: 'sha256', days: 3650,
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7, ip }))] }] });
    pems = { key: g.private, cert: g.cert, ips: String(ips) };
    fs.writeFileSync(CERT, JSON.stringify(pems));
  }
  https.createServer({ key: pems.key, cert: pems.cert }, onRequest).listen(HTTPS_PORT, () => {
    console.log('  LAN mode: player cams go through this PC, not Cloudflare.');
    console.log(`  OBS / vMix on this PC:  http://localhost:${PORT}/camcontrol  (Copy URL gives the /cam and /teamcam links)`);
    for (const ip of ips) console.log(`  Other PCs (Kirim Cam, panel):  https://${ip}:${HTTPS_PORT}/   (first time: "Advanced" -> "Proceed")`);
    console.log('');
  });
}
