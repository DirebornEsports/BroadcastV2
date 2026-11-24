// Direborn player cam relay (served under /api/cam/* by the broadcast Durable Object).
// Players publish a video track (+ a mic track) to Cloudflare Realtime (SFU) through /api/cam/publish; the OBS cam overlay
// pulls every cam through /api/cam/pull. The Cloudflare app secret never leaves the server.
// Who is live is kept in the Durable Object's storage (kvStore below).

const SFU = 'https://rtc.live.cloudflare.com/v1';
const NAME_RE = /^[\p{L}\p{N}_.\- ]{1,24}$/u;
const TRACK = 'cam', MIC = 'mic';
export const ONLINE_MS = 180000;      // browsers slow timers in background tabs: a heartbeat can be ~1 min late

export const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors } });
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function sameKey(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function need(env, ...keys) {
  const miss = keys.filter((k) => !env[k]);
  if (miss.length) throw new HttpError(500, 'Server belum di-setting: secret ' + miss.join(', ') + ' belum diisi di Cloudflare');
}
const checkPush = (env, key) => { need(env, 'PUSH_KEY'); if (!sameKey(key, env.PUSH_KEY)) throw new HttpError(403, 'Kunci kirim salah'); };
const checkView = (env, key) => { need(env, 'VIEW_KEY'); if (!sameKey(key, env.VIEW_KEY)) throw new HttpError(403, 'Kunci lihat salah'); };
function cleanName(n) {
  const s = String(n || '').trim();
  if (!NAME_RE.test(s)) throw new HttpError(400, 'Nama pemain tidak valid (1–24 huruf/angka)');
  return s;
}
const field = (n) => String(n).toLowerCase();

// ---------- Cloudflare Realtime ----------
async function sfu(env, method, path, body) {
  need(env, 'CF_APP_ID', 'CF_APP_SECRET');
  const r = await fetch(`${env.SFU_URL || SFU}/apps/${env.CF_APP_ID}${path}`, {
    method, headers: { authorization: `Bearer ${env.CF_APP_SECRET}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = null; try { d = await r.json(); } catch {}
  if (!r.ok || !d || d.errorCode) throw new HttpError(502, `Cloudflare Realtime (${path.replace(/\/sessions\/[^/]+/, '/sessions/…')}): ${(d && (d.errorDescription || d.errorCode)) || 'HTTP ' + r.status}`);
  return d;
}
async function sfuRaw(env, method, path, body, ct = true) {
  const r = await fetch(`${env.SFU_URL || SFU}/apps/${env.CF_APP_ID}${path}`, {
    method, headers: { authorization: `Bearer ${env.CF_APP_SECRET}`, ...(body !== undefined && ct ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text: j ? undefined : text.slice(0, 300) };
}
const trackError = (d) => (d.tracks || []).find((t) => t.errorCode);
async function iceServers(env) {
  if (env.SFU_URL) return [];                                  // local network (npm run lan): no STUN/TURN needed
  const list = [{ urls: 'stun:stun.cloudflare.com:3478' }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_TOKEN) return list;
  try {
    const r = await fetch(`${SFU}/turn/keys/${env.TURN_KEY_ID}/credentials/generate`, {
      method: 'POST', headers: { authorization: `Bearer ${env.TURN_KEY_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }),
    });
    const s = (await r.json()).iceServers;
    if (Array.isArray(s)) return s; if (s && s.urls) return [s];
  } catch {}
  return list;
}

// ---------- registry: one row per player in the Durable Object's storage ----------
export function kvStore(kv) {
  const P = 'cam:';
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  return { kind: 'durable-object',
    get: async (k) => { const v = kv.get(P + k); return v === undefined ? null : parse(v); },
    set: async (k, v) => { kv.put(P + k, JSON.stringify(v)); },
    del: async (k) => { kv.delete(P + k); },
    all: async () => kv.keys(P).map((k) => parse(kv.get(k))).filter(Boolean),
    // sessions the operator disconnected (their heartbeat gets told to stop)
    getKicked: async () => parse(kv.get('camx:kicked') || '[]') || [],
    setKicked: async (list) => { kv.put('camx:kicked', JSON.stringify(list.slice(-60))); } };
}

// ---------- routes ----------
async function run(route, req, env, store) {
  if (route === 'health') return json({ ok: true, configured: !!(env.CF_APP_ID && env.CF_APP_SECRET && env.PUSH_KEY && env.VIEW_KEY), store: store.kind, turn: !!(env.TURN_KEY_ID && env.TURN_KEY_TOKEN) });
  if (req.method !== 'POST') throw new HttpError(405, 'Pakai POST');
  let b; try { b = await req.json(); } catch { throw new HttpError(400, 'Body harus JSON'); }
  b = b || {};
  switch (route) {
    case 'check-push': checkPush(env, b.key); return json({ ok: true });
    case 'selftest': {
      // operator diagnostics: try the publish call in a few shapes, return Cloudflare's raw answers (SDP cut short)
      checkPush(env, b.key); need(env, 'CF_APP_ID', 'CF_APP_SECRET');
      const cut = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'sdp' && typeof v === 'string' ? v.slice(0, 60) + '…(' + v.length + ')' : v)));
      const offer = { type: 'offer', sdp: String(b.sdp || '') };
      const tracks = [{ location: 'local', mid: String(b.mid), trackName: 'cam' }];
      const out = [];
      const tryIt = async (label, fn) => { try { out.push({ label, ...(await fn()) }); } catch (e) { out.push({ label, error: e.message }); } };
      await tryIt('A: sessions/new kosong → tracks/new {sessionDescription, tracks}', async () => {
        const s = await sfuRaw(env, 'POST', '/sessions/new');
        if (!s.json || !s.json.sessionId) return { session: cut(s) };
        return { session: cut(s), tracks: cut(await sfuRaw(env, 'POST', `/sessions/${s.json.sessionId}/tracks/new`, { sessionDescription: offer, tracks })) };
      });
      await tryIt('B: sessions/new {} → tracks/new', async () => {
        const s = await sfuRaw(env, 'POST', '/sessions/new', {});
        if (!s.json || !s.json.sessionId) return { session: cut(s) };
        return { session: cut(s), tracks: cut(await sfuRaw(env, 'POST', `/sessions/${s.json.sessionId}/tracks/new`, { sessionDescription: offer, tracks })) };
      });
      await tryIt('C: sessions/new {sessionDescription} → tracks/new {tracks}', async () => {
        const s = await sfuRaw(env, 'POST', '/sessions/new', { sessionDescription: offer });
        if (!s.json || !s.json.sessionId) return { session: cut(s) };
        return { session: cut(s), tracks: cut(await sfuRaw(env, 'POST', `/sessions/${s.json.sessionId}/tracks/new`, { tracks })) };
      });
      if (b.sdp2 && b.mid2 && b.micMid2) await tryIt('D: video + mic sekaligus (seperti /kirim)', async () => {
        const s = await sfuRaw(env, 'POST', '/sessions/new');
        if (!s.json || !s.json.sessionId) return { session: cut(s) };
        return { session: cut(s), tracks: cut(await sfuRaw(env, 'POST', `/sessions/${s.json.sessionId}/tracks/new`, { sessionDescription: { type: 'offer', sdp: String(b.sdp2) },
          tracks: [{ location: 'local', mid: String(b.mid2), trackName: 'cam' }, { location: 'local', mid: String(b.micMid2), trackName: 'mic' }] })) };
      });
      return json({ ok: true, sdpLength: offer.sdp.length, sdpStart: offer.sdp.slice(0, 120), results: out });
    }
    case 'ice':
      if (!sameKey(b.key, env.PUSH_KEY) && !sameKey(b.key, env.VIEW_KEY)) throw new HttpError(403, 'Kunci salah');
      return json({ ok: true, iceServers: await iceServers(env) });
    case 'publish': {
      checkPush(env, b.key);
      const name = cleanName(b.name);
      if (!b.sdp || !b.mid) throw new HttpError(400, 'SDP / mid kosong');
      const s = await sfu(env, 'POST', '/sessions/new');
      const t = await sfu(env, 'POST', `/sessions/${s.sessionId}/tracks/new`, {
        sessionDescription: { type: 'offer', sdp: String(b.sdp) },
        tracks: [{ location: 'local', mid: String(b.mid), trackName: TRACK }, ...(b.micMid ? [{ location: 'local', mid: String(b.micMid), trackName: MIC }] : [])],
      });
      const te = trackError(t); if (te) throw new HttpError(502, `Cloudflare Realtime (tracks/new, track ${te.trackName || te.mid || '?'}): ${te.errorDescription || te.errorCode}`);
      const since = Date.now();
      await store.set(field(name), { name, sessionId: s.sessionId, mids: [String(b.mid), ...(b.micMid ? [String(b.micMid)] : [])], since, seen: since, mic: !!b.micMid, width: Number(b.width) || 0, height: Number(b.height) || 0, device: String(b.device || '').slice(0, 20) });
      return json({ ok: true, sessionId: s.sessionId, since, sdp: t.sessionDescription && t.sessionDescription.sdp });
    }
    case 'heartbeat': {
      checkPush(env, b.key);
      const name = cleanName(b.name), cur = await store.get(field(name));
      if (store.getKicked && (await store.getKicked()).includes(b.sessionId)) return json({ ok: true, current: false, kicked: true });
      if (!cur || cur.sessionId !== b.sessionId) return json({ ok: true, current: false });
      cur.seen = Date.now(); await store.set(field(name), cur);
      return json({ ok: true, current: true });
    }
    case 'unpublish': {
      checkPush(env, b.key);
      const name = cleanName(b.name), cur = await store.get(field(name));
      if (cur && (!b.sessionId || cur.sessionId === b.sessionId)) await store.del(field(name));   // a newer session of the same player stays
      return json({ ok: true });
    }
    case 'cams': {
      checkView(env, b.key);
      const now = Date.now();
      const cams = (await store.all()).sort((x, y) => x.name.localeCompare(y.name))
        .map((c) => ({ name: c.name, since: c.since, online: now - (c.seen || c.since) < ONLINE_MS, mic: !!c.mic, width: c.width, height: c.height, device: c.device || '' }));
      return json({ ok: true, now, cams });
    }
    case 'pull': {
      checkView(env, b.key);
      const name = cleanName(b.name), cam = await store.get(field(name));
      if (!cam || !cam.sessionId) throw new HttpError(404, 'Cam ' + name + ' sedang offline');
      const want = (mic) => [{ location: 'remote', sessionId: cam.sessionId, trackName: TRACK }, ...(mic ? [{ location: 'remote', sessionId: cam.sessionId, trackName: MIC }] : [])];
      let mic = !!cam.mic;
      let s = await sfu(env, 'POST', '/sessions/new');
      let t = await sfu(env, 'POST', `/sessions/${s.sessionId}/tracks/new`, { tracks: want(mic) });
      let te = trackError(t);
      if (te && mic && te.trackName === MIC && !(t.tracks || []).some((x) => x.trackName === TRACK && x.errorCode)) {
        // the mic is not there (yet): take the picture alone
        mic = false;
        s = await sfu(env, 'POST', '/sessions/new');
        t = await sfu(env, 'POST', `/sessions/${s.sessionId}/tracks/new`, { tracks: want(false) });
        te = trackError(t);
      }
      if (te) throw new HttpError(409, 'Cam ' + name + ' belum siap: ' + (te.errorDescription || te.errorCode));
      if (!t.sessionDescription || t.sessionDescription.type !== 'offer') throw new HttpError(502, 'Cloudflare Realtime tidak mengirim offer');
      return json({ ok: true, sessionId: s.sessionId, since: cam.since, mic, sdp: t.sessionDescription.sdp });
    }
    case 'pull-answer': {
      checkView(env, b.key);
      if (!b.sessionId || !b.sdp) throw new HttpError(400, 'sessionId / sdp kosong');
      await sfu(env, 'PUT', `/sessions/${encodeURIComponent(b.sessionId)}/renegotiate`, { sessionDescription: { type: 'answer', sdp: String(b.sdp) } });
      return json({ ok: true });
    }
  }
  throw new HttpError(404, 'Tidak ada');
}

// operator: disconnect one player (name) or everyone (no name). Stops the Cloudflare forwarding right away
// and tells the player's /kirim page to stop at its next heartbeat.
export async function kick(env, store, name) {
  const all = await store.all();
  const list = name ? all.filter((c) => c.name.toLowerCase() === String(name).toLowerCase()) : all;
  const kicked = store.getKicked ? await store.getKicked() : [];
  for (const c of list) {
    kicked.push(c.sessionId);
    await store.del(field(c.name));
    if (c.mids && c.mids.length && env.CF_APP_ID && env.CF_APP_SECRET) {
      try { await sfu(env, 'PUT', `/sessions/${c.sessionId}/tracks/close`, { tracks: c.mids.map((mid) => ({ mid })), force: true }); } catch {}
    }
  }
  if (store.setKicked) await store.setKicked(kicked);
  return list.map((c) => c.name);
}

export async function handle(route, req, env, store) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try { return await run(route, req, env, store); }
  catch (e) { return json({ ok: false, error: e.message || String(e) }, e.status || 500); }
}
