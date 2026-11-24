// Direborn broadcast on Cloudflare.
//   Worker (this file): operator login, routing, static pages (public/), uploads (R2).
//   Durable Object "Hub": the whole overlay server (draft, GSI, stats, bracket, cards, next match, ticker)
//   plus the player-cam relay under /api/cam/*. One instance holds the live state and streams it to every page.
import createHub from './hub.js';
import vfs from './vfs.js';
import adapter from './nodeadapter.js';
import { handle as camHandle, kvStore, kick as camKick } from '../lib/camcore.mjs';
import config from '../config.json' with { type: 'json' };
import seedStats from '../seed/stats.json' with { type: 'json' };
import seedStatcards from '../seed/statcards.json' with { type: 'json' };
import seedLinks from '../seed/links.json' with { type: 'json' };
import seedRoster from '../seed/roster.json' with { type: 'json' };
import seedOfficial from '../seed/official-roster.json' with { type: 'json' };
import manifest from './generated/manifest.json' with { type: 'json' };

const BUNDLE = {
  'config.json': JSON.stringify(config),
  'seed/stats.json': JSON.stringify(seedStats),
  'seed/statcards.json': JSON.stringify(seedStatcards),
  'seed/links.json': JSON.stringify(seedLinks),
  'seed/roster.json': JSON.stringify(seedRoster),
  'seed/official-roster.json': JSON.stringify(seedOfficial),
};
const BUILD = Number(manifest.__build) || 0;     // set by the build step; newer deploy = bigger number
const UPLOAD_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', gif: 'image/gif' };
const typeOf = (name) => UPLOAD_TYPES[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';

// ---------- operator login ----------
const COOKIE = 'dbo_admin';
// operator pages: need the password. OBS sources and the players' /kirim page stay open.
const ADMIN_PAGES = new Set(['/', '/control', '/teams', '/stats', '/bracket', '/cards', '/camcontrol', '/lihat', '/camdebug', '/mix']);
// GET endpoints that show private data
const ADMIN_GET = new Set(['/api/gsi-last', '/api/stats/export.xlsx', '/api/stats/accounts', '/api/roster-sync', '/api/cam/admin']);

async function sign(env) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.ADMIN_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('dbo-admin-v1')));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function same(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function isAdmin(request, env) {
  // Direborn Studio (local): the operator at this PC needs no password; dev/local.mjs sets this header only for loopback
  if (env.LOCAL_ADMIN && request.headers.get('x-dbo-local') === '1') return true;
  if (!env.ADMIN_PASSWORD) return false;
  const m = /(?:^|;\s*)dbo_admin=([^;]+)/.exec(request.headers.get('cookie') || '');
  return !!m && same(m[1], await sign(env));
}
const safeNext = (n) => (typeof n === 'string' && /^\/[^/\\]/.test(n) ? n : '/control');
async function login(request, env) {
  const form = await request.formData().catch(() => null);
  const next = safeNext(form && form.get('next'));
  if (!env.ADMIN_PASSWORD) return Response.redirect(new URL('/login?e=setup', request.url), 303);
  if (!form || !same(form.get('password'), env.ADMIN_PASSWORD)) return Response.redirect(new URL('/login?e=1&next=' + encodeURIComponent(next), request.url), 303);
  return new Response(null, { status: 303, headers: { location: next, 'set-cookie': `${COOKIE}=${await sign(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` } });
}

// which requests need the operator login
function needsAdmin(p, method) {
  if (p === '/gsi') return false;                                   // GSI token
  if (p.startsWith('/api/cam/')) return p === '/api/cam/admin' || p === '/api/cam/kick';   // player keys / view key
  if (p === '/api/playercam/status') return false;                  // view key (checked below)
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') return true;
  return ADMIN_GET.has(p);
}

const hubStub = (env) => env.HUB.get(env.HUB.idFromName('main'), { locationHint: 'apac' });
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;
    // setup check: which secrets the running Worker can see (never their values)
    if (p === '/setup-check') {
      const names = ['ADMIN_PASSWORD', 'GSI_TOKEN', 'PUSH_KEY', 'VIEW_KEY', 'CF_APP_ID', 'CF_APP_SECRET', 'TURN_KEY_ID', 'TURN_KEY_TOKEN'];
      const rows = names.map((n) => `<tr><td>${n}</td><td style="color:${env[n] ? '#8fdc8f' : '#f6b1a4'}">${env[n] ? 'ada' : 'belum ada'}</td></tr>`).join('');
      return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Setup check</title><body style="font:15px system-ui;background:#0a1a12;color:#f4e8c6;padding:24px"><h2>Secret yang terbaca oleh Worker</h2><table cellpadding="6">${rows}</table><p>R2 (opsional): ${env.UPLOADS ? 'tersambung' : 'tidak dipakai — logo disimpan di Durable Object'}</p><p>Yang wajib: ADMIN_PASSWORD, GSI_TOKEN, PUSH_KEY, VIEW_KEY. CF_APP_ID & CF_APP_SECRET untuk player cam.</p></body>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (p === '/login' && method === 'POST') return login(request, env);
    if (p === '/logout') return new Response(null, { status: 303, headers: { location: '/login', 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } });
    const admin = await isAdmin(request, env);

    // uploaded team logos / player photos (R2)
    if (p.startsWith('/logos/uploads/')) {
      if (!env.UPLOADS) return hubStub(env).fetch(request);              // no R2 bucket: uploads live in the Durable Object
      const key = 'uploads/' + p.slice('/logos/uploads/'.length);
      const obj = await env.UPLOADS.get(key);
      if (!obj) return new Response('Not found', { status: 404 });
      return new Response(obj.body, { headers: { 'content-type': (obj.httpMetadata && obj.httpMetadata.contentType) || typeOf(key), 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*' } });
    }

    // everything live goes to the Hub
    if (p === '/gsi' || p === '/events' || p.startsWith('/api/') || p.startsWith('/img/')) {
      if (needsAdmin(p, method) && !admin) return json({ ok: false, error: 'Login operator dulu (buka /login)' }, 401);
      if (p === '/api/playercam/status' && method === 'POST' && !admin && !same(url.searchParams.get('k'), env.VIEW_KEY)) return json({ ok: false, error: 'Kunci lihat salah' }, 403);
      const headers = new Headers(request.headers);
      headers.delete('x-dbo-admin');
      if (admin) headers.set('x-dbo-admin', '1');
      headers.set('x-dbo-build', String(BUILD));
      const body = ['GET', 'HEAD'].includes(method) ? undefined : await request.arrayBuffer();
      for (let i = 0; ; i++) {
        const r = await hubStub(env).fetch(new Request(request.url, { method, headers, body }));
        // the Durable Object was still on older code: it restarts itself, try again on the new code
        if (r.status === 503 && r.headers.get('x-dbo-restart') && i < 4) { await new Promise((ok) => setTimeout(ok, 400 * (i + 1))); continue; }
        return r;
      }
    }

    // pages
    if (p === '/') return Response.redirect(new URL('/control', request.url), 302);
    const page = p.replace(/\.html$/, '');
    if (ADMIN_PAGES.has(page) && !admin) return Response.redirect(new URL('/login?next=' + encodeURIComponent(p + url.search), request.url), 302);
    if (page === '/nextmatch-wide') return env.ASSETS.fetch(new Request(new URL('/nextmatch' + url.search, request.url), request));
    return env.ASSETS.fetch(request);
  },
};

// ---------- the Durable Object ----------
export class Hub {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    const kv = vfs.sqlKv(ctx.storage.sql);
    const blobs = env.UPLOADS ? {
      put: (key, data) => env.UPLOADS.put(key, data, { httpMetadata: { contentType: typeOf(key) } }),
      delete: (key) => env.UPLOADS.delete(key),
    } : null;
    this.fs = vfs.createFs({ kv, bundle: BUNDLE, manifest, blobs });
    this.hub = createHub({ fs: this.fs, env });
    this.cam = kvStore(kv);
    this.hub.start();
  }
  async fetch(request) {
    const url = new URL(request.url);
    const admin = request.headers.get('x-dbo-admin') === '1';
    // a request from a newer deploy reached this (older) instance: drop the live streams and restart on the new code
    const from = Number(request.headers.get('x-dbo-build')) || 0;
    if (BUILD && from > BUILD) {
      try { this.hub.saveNow(); } catch {}
      try { this.hub.dropClients(); } catch {}
      if (this.ctx.abort) setTimeout(() => { try { this.ctx.abort('code update'); } catch {} }, 50);
      return new Response('restarting for the new version', { status: 503, headers: { 'x-dbo-restart': '1', 'retry-after': '1' } });
    }
    if (url.pathname.startsWith('/logos/uploads/')) {
      const name = url.pathname.slice('/logos/uploads/'.length);
      const buf = this.fs.readUpload(name);
      if (!buf) return new Response('Not found', { status: 404 });
      return new Response(buf, { headers: { 'content-type': typeOf(name), 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*' } });
    }
    if (url.pathname.startsWith('/api/cam/')) {
      const route = url.pathname.slice('/api/cam/'.length).replace(/\/+$/, '').replace('/', '-');
      if (route === 'admin') {
        return json({ ok: true, pushKey: this.env.PUSH_KEY || '', viewKey: this.env.VIEW_KEY || '',
          configured: !!(this.env.CF_APP_ID && this.env.CF_APP_SECRET && this.env.PUSH_KEY && this.env.VIEW_KEY), turn: !!(this.env.TURN_KEY_ID && this.env.TURN_KEY_TOKEN) });
      }
      if (route === 'kick') {
        if (!admin) return json({ ok: false, error: 'Login operator dulu' }, 401);
        const b = await request.json().catch(() => ({}));
        return json({ ok: true, kicked: await camKick(this.env, this.cam, b && b.name) });
      }
      return camHandle(route, request, this.env, this.cam);
    }
    return adapter.runNodeHandler(this.hub.handler, request, { isAdmin: admin });
  }
}
