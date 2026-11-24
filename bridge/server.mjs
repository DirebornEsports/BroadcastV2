// Direborn Cam bridge (2.0 prototype): turns WHIP (what ffmpeg / the Direborn Cam app sends) into the Cloudflare
// Realtime SFU calls, and lets the Studio receiver pull a cam by player name.
//   online: CF_APP_ID + CF_APP_SECRET set -> Cloudflare Realtime
//   LAN:    not set                        -> local SFU in this process (localsfu.mjs, copied from v1)
//
//   POST   /whip/<name>              body: SDP offer (application/sdp) -> 201 SDP answer, Location: /whip/<name>/<sessionId>
//   DELETE /whip/<name>/<sessionId>
//   GET    /cams                     -> [{ name, since }]
//   POST   /pull/<name>              -> { sessionId, sdp }   (sdp = offer from the SFU)
//   POST   /pull/<sessionId>/answer  body: SDP answer (application/sdp) -> 204
// Optional KEY env: every request needs ?k=<KEY>.
import http from 'node:http';

const PORT = Number(process.env.PORT) || 8787;
const KEY = process.env.KEY || '';
const CF = process.env.CF_APP_ID && process.env.CF_APP_SECRET;
const NAME_RE = /^[\p{L}\p{N}_.\- ]{1,24}$/u;
const localSfu = CF ? null : (await import('./localsfu.mjs')).localSfu;

async function sfu(method, path, body) {
  let status, j;
  if (localSfu) [status, j] = await localSfu(method, path, body);
  else {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${process.env.CF_APP_ID}${path}`, {
      method, headers: { authorization: `Bearer ${process.env.CF_APP_SECRET}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,   // sessions/new must have no body
    });
    status = r.status; j = await r.json().catch(() => null);
  }
  const te = j && (j.tracks || []).find((t) => t.errorCode);
  if (status >= 300 || !j || j.errorCode || te) throw new Error(`SFU ${path.replace(/sessions\/\w+/, 'sessions/…')}: ${(te || j || {}).errorDescription || (te || j || {}).errorCode || 'HTTP ' + status}`);
  return j;
}

const cams = new Map();   // lower-case name -> { name, sessionId, since }
// the mid of the first m=video section of an offer
const videoMid = (sdp) => (/m=video[\s\S]*?a=mid:(\S+)/.exec(sdp) || [])[1];

async function route(req, url, body) {
  const p = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (req.method === 'GET' && p[0] === 'cams') return [200, 'application/json', JSON.stringify([...cams.values()].map(({ name, since }) => ({ name, since })))];
  if (p[0] === 'whip' && req.method === 'POST' && p.length === 2) {
    const name = p[1]; if (!NAME_RE.test(name)) return [400, 'text/plain', 'nama tidak valid'];
    const mid = videoMid(body); if (!mid) return [400, 'text/plain', 'offer tanpa video'];
    const s = await sfu('POST', '/sessions/new');
    const t = await sfu('POST', `/sessions/${s.sessionId}/tracks/new`, { sessionDescription: { type: 'offer', sdp: body }, tracks: [{ location: 'local', mid, trackName: 'cam' }] });
    cams.set(name.toLowerCase(), { name, sessionId: s.sessionId, since: Date.now() });
    console.log(`[whip] ${name} live (session ${s.sessionId.slice(0, 8)})`);
    return [201, 'application/sdp', t.sessionDescription.sdp, { location: `/whip/${encodeURIComponent(name)}/${s.sessionId}` }];
  }
  if (p[0] === 'whip' && req.method === 'DELETE' && p.length === 3) {
    const cur = cams.get(p[1].toLowerCase());
    if (cur && cur.sessionId === p[2]) { cams.delete(p[1].toLowerCase()); await sfu('PUT', `/sessions/${p[2]}/tracks/close`, { tracks: [{ mid: '0' }], force: true }).catch(() => {}); }
    return [200, 'text/plain', ''];
  }
  if (p[0] === 'pull' && req.method === 'POST' && p.length === 2) {
    const cam = cams.get(p[1].toLowerCase()); if (!cam) return [404, 'text/plain', 'cam offline'];
    const s = await sfu('POST', '/sessions/new');
    const t = await sfu('POST', `/sessions/${s.sessionId}/tracks/new`, { tracks: [{ location: 'remote', sessionId: cam.sessionId, trackName: 'cam' }] });
    return [200, 'application/json', JSON.stringify({ sessionId: s.sessionId, sdp: t.sessionDescription.sdp })];
  }
  if (p[0] === 'pull' && req.method === 'POST' && p.length === 3 && p[2] === 'answer') {
    await sfu('PUT', `/sessions/${p[1]}/renegotiate`, { sessionDescription: { type: 'answer', sdp: body } });
    return [204, 'text/plain', ''];
  }
  return [404, 'text/plain', 'tidak ada'];
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-expose-headers': 'location' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
  if (KEY && url.searchParams.get('k') !== KEY) { res.writeHead(403, cors).end('kunci salah'); return; }
  let body = ''; for await (const c of req) { body += c; if (body.length > 200000) { res.writeHead(413, cors).end(); return; } }
  try {
    const [status, type, out, extra] = await route(req, url, body);
    // explicit length, no chunked encoding: ffmpeg's WHIP muxer can't read chunked answers
    res.writeHead(status, { ...cors, 'content-type': type, 'content-length': Buffer.byteLength(out), ...extra }).end(out);
  } catch (e) {
    console.error('[error]', e.message);
    res.writeHead(502, { ...cors, 'content-type': 'text/plain' }).end(e.message);
  }
}).listen(PORT, () => console.log(`bridge on :${PORT} (${CF ? 'Cloudflare Realtime' : 'LAN SFU'})`));
