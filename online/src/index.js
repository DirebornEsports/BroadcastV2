// Direborn Cam ONLINE relay (Cloudflare Worker + one Durable Object). Players at home send their cam here instead of
// to the Studio PC; the media itself goes through Cloudflare Realtime (SFU). Direborn Studio (bridge/server.mjs, online
// mode) pushes the PIN list, lists the live cams and pulls them, so the Studio PC never has to be reachable from outside.
//
// Players (Direborn Cam app, ffmpeg WHIP):
//   GET    /pin/<pin>                -> { name, team, kind } | 404
//   POST   /whip/<any>?pin=<pin>     body: SDP offer -> 201 SDP answer, Location: /whip/<name>/<sessionId>
//   DELETE /whip/<name>/<sessionId>
// Studio (header x-studio-key = STUDIO_KEY secret):
//   PUT    /pins                     body: [{ pin, name, team, kind }]
//   GET    /cams                     -> [{ name, since, mic }]
//   POST   /pull/<name>              -> { sessionId, sdp }
//   POST   /pull/<sessionId>/answer  body: SDP answer -> 204
// Secrets: CF_APP_ID, CF_APP_SECRET (Realtime → Serverless SFU app), STUDIO_KEY (any long random string, same as in Studio).
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, x-studio-key', 'access-control-expose-headers': 'location' };
const out = (status, body = '', type = 'text/plain', extra = {}) => new Response(body, { status, headers: { ...CORS, 'content-type': type, ...extra } });
const json = (status, v) => out(status, JSON.stringify(v), 'application/json');
// the mid of the first m=video / m=audio section of an offer
const mid = (sdp, kind) => (new RegExp(`m=${kind}[^]*?a=mid:(\\S+)`).exec(sdp) || [])[1];

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    return env.REG.get(env.REG.idFromName('main')).fetch(req);
  },
};

export class Registry {
  constructor(state, env) { this.state = state; this.env = env; }

  async sfu(method, path, body) {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${this.env.CF_APP_ID}${path}`, {
      method, headers: { authorization: `Bearer ${this.env.CF_APP_SECRET}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,   // sessions/new must have no body
    });
    const j = await r.json().catch(() => null), te = j && (j.tracks || []).find((t) => t.errorCode);
    if (r.status >= 300 || !j || j.errorCode || te) throw new Error(`SFU: ${(te || j || {}).errorDescription || (te || j || {}).errorCode || 'HTTP ' + r.status}`);
    return j;
  }
  // both kept in storage: the object can be evicted between requests
  pins() { return this.state.storage.get('pins').then((p) => p || []); }
  cams() { return this.state.storage.get('cams').then((c) => c || {}); }

  async fetch(req) {
    const url = new URL(req.url), p = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    try {
      if (req.method === 'GET' && p.length === 0) return out(200, 'Direborn Cam online relay');
      if (req.method === 'GET' && p[0] === 'pin' && p.length === 2) {
        const x = (await this.pins()).find((q) => q.pin === p[1]);
        return x ? json(200, { name: x.name, team: x.team, kind: x.kind }) : out(404, 'PIN salah');
      }
      if (p[0] === 'whip' && req.method === 'POST' && p.length === 2) {
        const who = (await this.pins()).find((q) => q.pin === url.searchParams.get('pin'));
        if (!who) return out(403, 'PIN salah');
        const sdp = await req.text();
        if (sdp.length > 200000) return out(413);
        const vmid = mid(sdp, 'video'), amid = mid(sdp, 'audio');
        if (!vmid) return out(400, 'offer tanpa video');
        const s = await this.sfu('POST', '/sessions/new');
        const t = await this.sfu('POST', `/sessions/${s.sessionId}/tracks/new`, { sessionDescription: { type: 'offer', sdp },
          tracks: [{ location: 'local', mid: vmid, trackName: 'cam' }, ...(amid ? [{ location: 'local', mid: amid, trackName: 'mic' }] : [])] });
        const cams = await this.cams();
        cams[who.name.toLowerCase()] = { name: who.name, sessionId: s.sessionId, since: Date.now(), mic: !!amid };
        await this.state.storage.put('cams', cams);
        return out(201, t.sessionDescription.sdp, 'application/sdp', { location: `/whip/${encodeURIComponent(who.name)}/${s.sessionId}` });
      }
      if (p[0] === 'whip' && req.method === 'DELETE' && p.length === 3) {
        const cams = await this.cams(), k = p[1].toLowerCase();
        if (cams[k] && cams[k].sessionId === p[2]) {
          delete cams[k]; await this.state.storage.put('cams', cams);
          await this.sfu('PUT', `/sessions/${p[2]}/tracks/close`, { tracks: [{ mid: '0' }], force: true }).catch(() => {});
        }
        return out(200);
      }

      // ---------- Studio only ----------
      if (!this.env.STUDIO_KEY || req.headers.get('x-studio-key') !== this.env.STUDIO_KEY) return out(403, 'kunci studio salah');
      if (p[0] === 'pins' && req.method === 'PUT') {
        const list = await req.json();
        if (!Array.isArray(list)) return out(400, 'pins harus array');
        await this.state.storage.put('pins', list.filter((x) => x && /^\d{4}$/.test(x.pin) && x.name).map(({ pin, name, team, kind }) => ({ pin, name: String(name), team: String(team || ''), kind: kind === 'team' ? 'team' : 'player' })));
        return out(204);
      }
      if (p[0] === 'cams' && req.method === 'GET') return json(200, Object.values(await this.cams()).map(({ name, since, mic }) => ({ name, since, mic })));
      if (p[0] === 'pull' && req.method === 'POST' && p.length === 2) {
        const cam = (await this.cams())[p[1].toLowerCase()]; if (!cam) return out(404, 'cam offline');
        const s = await this.sfu('POST', '/sessions/new');
        const t = await this.sfu('POST', `/sessions/${s.sessionId}/tracks/new`, { tracks: ['cam', ...(cam.mic ? ['mic'] : [])].map((trackName) => ({ location: 'remote', sessionId: cam.sessionId, trackName })) });
        return json(200, { sessionId: s.sessionId, sdp: t.sessionDescription.sdp });
      }
      if (p[0] === 'pull' && req.method === 'POST' && p.length === 3 && p[2] === 'answer') {
        await this.sfu('PUT', `/sessions/${p[1]}/renegotiate`, { sessionDescription: { type: 'answer', sdp: await req.text() } });
        return out(204);
      }
      return out(404, 'tidak ada');
    } catch (e) {
      return out(502, e.message);
    }
  }
}
