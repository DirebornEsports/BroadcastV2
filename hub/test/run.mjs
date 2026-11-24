// End-to-end test of the online version, run against the local Cloudflare emulator (dev/local.mjs).
//   node test/run.mjs        (needs Playwright + Chromium)
// Cloudflare Realtime is replaced by an "SFU page": RTCPeerConnections in Chromium that receive the
// player's track and re-send it to viewers, so the cam path runs for real.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const OUT = process.env.OUT || path.join(ROOT, 'test/out/'); fs.mkdirSync(OUT, { recursive: true });
const PORT = 8798, H = `http://localhost:${PORT}`;
Object.assign(process.env, { PORT: String(PORT), DEV_PERSIST: '0', ADMIN_PASSWORD: 'rahasia-operator', GSI_TOKEN: 'tok-123', CF_APP_ID: 'app1', CF_APP_SECRET: 'sec', PUSH_KEY: 'pk-1', VIEW_KEY: 'vk-1', DEV_DATA: path.join(OUT, 'data') });
fs.rmSync(path.join(OUT, 'data'), { recursive: true, force: true });

// ---- Cloudflare Realtime replaced by a page full of RTCPeerConnections ----
let sfuPage = null, sid = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init = {}) => {
  const url = String(u);
  // OpenDota stand-in for the league ticket import
  if (url === 'https://api.opendota.com/api/leagues/99999/teams') return Response.json([
    { team_id: 101, name: 'Direborn', tag: 'DB', logo_url: '', last_match_time: Math.floor(Date.now() / 1000) - 86400, wins: 3, losses: 1 },
    { team_id: 102, name: 'Resp Gaming', tag: 'RESP', logo_url: '', last_match_time: Math.floor(Date.now() / 1000) - 3 * 86400, wins: 2, losses: 2 },
    { team_id: 103, name: 'Old Team', tag: 'OLD', logo_url: '', last_match_time: Math.floor(Date.now() / 1000) - 200 * 86400, wins: 1, losses: 5 }]);
  if (url.startsWith('https://api.opendota.com/api/explorer?sql=')) { const q = decodeURIComponent(url.split('sql=')[1]); return Response.json({ rows: /ILIKE '%epl%' AND name ILIKE '%southeast%'/i.test(q) && !/;/.test(q) ? [{ leagueid: 20277, name: 'EPL World Series: Southeast Asia 2026-2027 Season', tier: 'professional' }] : [] }); }
  if (url === 'https://api.opendota.com/api/leagues/99999') return Response.json({ leagueid: 99999, name: 'EPL World Series SEA Test' });
  if (/^https:\/\/api\.opendota\.com\/api\/teams\/(101|102)\/players$/.test(url)) return Response.json([
    { account_id: 1001 + Number(url.match(/teams\/(\d+)/)[1]), name: 'Starter A', games_played: 30, is_current_team_member: true },
    { account_id: 2002 + Number(url.match(/teams\/(\d+)/)[1]), name: 'Starter B', games_played: 25, is_current_team_member: true },
    { account_id: 3003, name: 'Former', games_played: 50, is_current_team_member: false }]);
  if (!url.startsWith('https://rtc.live.cloudflare.com')) return realFetch(u, init);
  const body = init.body ? JSON.parse(init.body) : null, p = url.replace(/^.*\/apps\/[^/]+/, '');
  if (p === '/sessions/new') return Response.json({ sessionId: 'S' + (++sid) });
  const m = p.match(/^\/sessions\/([^/]+)\/(tracks\/new|renegotiate)$/);
  if (m && m[2] === 'tracks/new' && body.tracks[0].location === 'local') return Response.json({ sessionDescription: { type: 'answer', sdp: await sfuPage.evaluate(([s, o, t]) => window.sfu.publish(s, o, t), [m[1], body.sessionDescription.sdp, body.tracks]) }, tracks: body.tracks });
  if (m && m[2] === 'tracks/new') {
    const r = await sfuPage.evaluate(([s, f, n]) => window.sfu.subscribe(s, f, n), [m[1], body.tracks[0].sessionId, body.tracks.map((t) => t.trackName)]);
    if (r.error) return Response.json({ tracks: body.tracks.map((t) => ({ ...t, errorCode: 'not_found', errorDescription: r.error })) });
    return Response.json({ requiresImmediateRenegotiation: true, sessionDescription: { type: 'offer', sdp: r.sdp }, tracks: body.tracks });
  }
  if (m && m[2] === 'renegotiate') { await sfuPage.evaluate(([s, a]) => window.sfu.answer(s, a), [m[1], body.sessionDescription.sdp]); return Response.json({}); }
  return new Response('?', { status: 404 });
};
const SFU = `window.sfu = (() => { const pubs = {}, subs = {};
  const wait = (pc) => new Promise((res) => { if (pc.iceGatheringState === 'complete') return res(); const t = setTimeout(res, 2000); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } }; });
  return {
    async publish(s, offer, tracks) { const pc = new RTCPeerConnection(); (window.__pcs = window.__pcs || []).push(pc); const p = pubs[s] = { pc, byName: {} }; window.sfu.names = window.sfu.names || {};
      pc.ontrack = (e) => { const t = tracks.find((x) => x.mid === e.transceiver.mid); if (t) p.byName[t.trackName] = e.track; if (e.track.kind === 'audio') { const a = new Audio(); a.srcObject = new MediaStream([e.track]); a.volume = 0; a.play().catch(() => {}); (window.__els = window.__els || []).push(a); } };
      await pc.setRemoteDescription({ type: 'offer', sdp: offer }); await pc.setLocalDescription(await pc.createAnswer()); await wait(pc); return pc.localDescription.sdp; },
    async subscribe(s, from, names) { const p = pubs[from]; if (!p) return { error: 'no session' };
      for (let i = 0; i < 50 && names.some((n) => !p.byName[n]); i++) await new Promise((r) => setTimeout(r, 100)); if (names.some((n) => !p.byName[n])) return { error: 'no track' };
      const pc = new RTCPeerConnection(); (window.__pcs = window.__pcs || []).push(pc); subs[s] = pc;
      for (const n of names) { const tr = pc.addTransceiver(p.byName[n], { direction: 'sendonly' });
        if (n === 'cam') tr.setCodecPreferences(RTCRtpSender.getCapabilities('video').codecs.filter((c) => /vp8|rtx/i.test(c.mimeType))); }
      await pc.setLocalDescription(await pc.createOffer()); await wait(pc); return { sdp: pc.localDescription.sdp }; },
    async answer(s, sdp) { await subs[s].setRemoteDescription({ type: 'answer', sdp }); } }; })();`;

await import(path.join(ROOT, 'dev/local.mjs'));
await new Promise((r) => setTimeout(r, 800));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const results = [];
const note = (c, m) => results.push((c ? 'ok   ' : 'note ') + m + (c ? '' : '  (headless fake mic: cek manual)'));
const ok = (c, m) => { results.push((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const errs = [];
const watch = (p, tag) => { p.on('pageerror', (e) => errs.push(tag + ': ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|Failed to load resource|ERR_CONNECTION|net::/.test(m.text())) errs.push(tag + ' console: ' + m.text()); }); };
try {
  // ---------- operator login ----------
  const op = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const pg = await op.newPage(); watch(pg, 'control');
  await pg.goto(H + '/control');
  ok(pg.url().includes('/login?next=%2Fcontrol'), 'control panel asks for login');
  await pg.screenshot({ path: OUT + 'login.png' });
  await pg.fill('input[name=password]', 'salah'); await pg.click('button[type=submit]');
  await pg.waitForURL(/e=1/); await sleep(300);
  ok(await pg.isVisible('#err') && (await pg.textContent('#err')) === 'Password salah.', 'wrong password refused');
  await pg.fill('input[name=password]', 'rahasia-operator'); await pg.click('button[type=submit]');
  await pg.waitForURL(/\/control$/); await sleep(1500);
  ok(await pg.title() === 'Draft Control', 'logged in → control panel');
  const opFetch = (url, body, method) => pg.evaluate(async ([u, b, m]) => { const r = await fetch(u, { method: m || (b === null ? 'GET' : 'POST'), headers: { 'content-type': 'application/json' }, body: b === null ? undefined : JSON.stringify(b) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, j, len: t.length, type: r.headers.get('content-type') }; }, [url, body, method]);

  // ---------- public (OBS) context: no cookie ----------
  const pub = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const anon = async (u, init) => { const r = await realFetch(H + u, init); return { status: r.status, text: await r.text() }; };
  ok((await anon('/api/action', { method: 'POST', body: '{"type":"visible","visible":false}' })).status === 401, 'actions refused without login');
  ok((await anon('/api/stats/export.xlsx')).status === 401, 'Excel export needs login');
  ok((await anon('/teams', { redirect: 'manual' })).status === 302, 'teams page needs login');
  ok((await anon('/overlay')).status === 200 && (await anon('/statcards')).status === 200 && (await anon('/ingame')).status === 200, 'OBS pages open without login');
  const pubState = JSON.parse((await anon('/api/state')).text);
  ok(pubState.playerCam && !('viewKey' in pubState.playerCam) && !pubState.gsi.diag, 'public state has no keys / GSI diagnostics');

  // ---------- teams (seeded from the official roster) + logo upload to R2 ----------
  const teams = (await opFetch('/api/teams', null)).j;
  ok(Array.isArray(teams) && teams.length >= 8, `teams database seeded (${teams.length} teams)`);
  const up = await pg.evaluate(async () => { const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)); const r = await fetch('/api/upload-logo', { method: 'POST', headers: { 'x-filename': 'Direborn Logo.png' }, body: png }); return r.json(); });
  ok(up.ok && /^\/logos\/uploads\/direborn-logo-/.test(up.path), 'logo upload: ' + up.path);
  await sleep(300);
  const img = await realFetch(H + up.path); ok(img.status === 200 && img.headers.get('content-type') === 'image/png' && (await img.arrayBuffer()).byteLength === 70, 'uploaded logo served back');

  // ---------- draft: overlay follows the control panel live ----------
  const ov = await pub.newPage(); watch(ov, 'overlay'); await ov.goto(H + '/overlay?bg=1'); await sleep(1500);
  const capture = (p) => p.evaluate(() => new Promise((res) => { const es = new EventSource('/events'); es.onmessage = (e) => { res(JSON.parse(e.data)); es.close(); }; }));
  await opFetch('/api/action', { type: 'loadTeam', side: 'left', teamId: teams[0].id });
  await opFetch('/api/action', { type: 'loadTeam', side: 'right', teamId: teams[1].id });
  for (const h of [2, 14, 25]) { const r = await opFetch('/api/action', { type: 'assign', heroId: h }); if (!r.j.ok) results.push('  assign: ' + r.j.error); }
  await sleep(800);
  const st = await capture(ov);
  const filled = ['left', 'right'].flatMap((s) => [...st.slots[s].bans, ...st.slots[s].picks]).filter(Boolean).length;
  ok(st.teams.left.name === teams[0].name && filled === 3, `overlay gets live state (${st.teams.left.name} vs ${st.teams.right.name}, ${filled} heroes)`);
  await ov.screenshot({ path: OUT + 'overlay.png' });

  // ---------- GSI ----------
  ok((await anon('/gsi', { method: 'POST', body: JSON.stringify({ auth: { token: 'wrong' } }) })).status === 401, 'GSI with wrong token refused');
  await opFetch('/api/action', { type: 'mode', mode: 'gsi' });
  const gsiBody = { auth: { token: 'tok-123' }, provider: { name: 'Dota 2', appid: 570 }, map: { matchid: '9999', game_state: 'DOTA_GAMERULES_STATE_HERO_SELECTION' },
    draft: { activeteam: 2, pick: true, activeteam_time_remaining: 25, radiant_bonus_time: 100, dire_bonus_time: 100, team2: { home_team: true, pick0_id: 1, pick0_class: 'antimage', ban0_id: 2, ban0_class: 'axe' }, team3: { home_team: false, pick0_id: 8, pick0_class: 'juggernaut' } } };
  ok((await anon('/gsi', { method: 'POST', body: JSON.stringify(gsiBody) })).status === 200, 'GSI accepted with the secret token');
  await sleep(500);
  const st2 = await capture(ov);
  const gsiHeroes = ['left', 'right'].flatMap((s) => [...st2.slots[s].bans, ...st2.slots[s].picks]).filter(Boolean);
  ok(gsiHeroes.includes(1) && gsiHeroes.includes(8) && gsiHeroes.includes(2), 'draft from GSI shows on the overlay');
  const adm = (await opFetch('/api/state', null)).j;
  ok(adm.gsi.diag && adm.gsi.diag.count >= 1 && adm.gsi.diag.draftPicks === 2, 'operator sees GSI diagnostics');

  // ---------- stats / bracket / cards / next match / Excel ----------
  const stats = (await opFetch('/api/stats', null)).j;
  ok(stats.matches.length > 0, `stats loaded (${stats.matches.length} matches, ${stats.tournament})`);
  const xl = await opFetch('/api/stats/export.xlsx', null);
  ok(xl.status === 200 && /spreadsheetml/.test(xl.type), 'Excel export works online');
  const tc = (await opFetch('/api/tournaments/create', { name: 'Online Test Cup' })).j;
  ok(tc.ok && tc.active === 'online-test-cup', 'new tournament');
  const BF = require(path.join(ROOT, 'public/bracket-formats.js'));
  const br = BF.make('single-elimination-4'); br.matches[0].a.name = teams[0].name; br.matches[0].b.name = teams[1].name; br.matches[0].date = (() => { const d = new Date(Date.now() + 2 * 864e5); return d.getDate() + '/' + (d.getMonth() + 1); })(); br.matches[0].time = '19.00';
  ok((await opFetch('/api/bracket', { bracket: br })).j.ok, 'bracket saved');
  const cards = (await realFetch(H + '/api/statcards').then((r) => r.json()));
  ok(cards.bracket && cards.bracket.format === 'single-elimination-4' && cards.cards.some((c) => c.id === 'bracket'), 'bracket card uses the new tournament');
  const nm = await realFetch(H + '/api/nextmatch').then((r) => r.json());
  ok(nm.a && nm.a.name === teams[0].name, 'next match from the bracket: ' + nm.a.name + ' vs ' + nm.b.name);
  await opFetch('/api/action', { type: 'statCard', id: 'bracket' });
  const sc = await pub.newPage(); watch(sc, 'statcards'); await sc.goto(H + '/statcards?bg=1'); await sleep(3500);
  await sc.screenshot({ path: OUT + 'statcard-bracket.png' });
  ok(await sc.evaluate(() => !!document.querySelector('.brk .m')), 'bracket stat card shows in OBS source');

  // ---------- restart: everything was saved in the Durable Object ----------
  globalThis.__devRestartHub();
  const after = JSON.parse((await anon('/api/state')).text);
  ok(after.tournament === 'Online Test Cup' && after.mode === 'gsi' && after.teams.left.name === 'TEAM A', 'state survives a Durable Object restart (new tournament starts without the Cup teams)');
  const brAfter = (await opFetch('/api/bracket', null)).j;
  ok(brAfter.bracket && brAfter.bracket.matches.length === 3, 'bracket survives restart');

  // ---------- player cams on the same server ----------
  sfuPage = await (await browser.newContext()).newPage(); await sfuPage.goto(H + '/login'); await sfuPage.addScriptTag({ content: SFU });
  const camCtx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1366, height: 820 } });
  const pl = await camCtx.newPage(); watch(pl, 'kirim');
  await pl.addInitScript(() => { const P = window.RTCPeerConnection; window.RTCPeerConnection = function (...a) { const pc = new P(...a); (window.__pcs = window.__pcs || []).push(pc); return pc; }; window.RTCPeerConnection.prototype = P.prototype; Object.setPrototypeOf(window.RTCPeerConnection, P); });
  await pl.goto(H + '/kirim?p=Dreamocel&k=pk-1'); await sleep(600); await pl.click('#go');
  await pl.waitForFunction(() => document.getElementById('pillTxt').textContent === 'LIVE', null, { timeout: 20000 });
  ok(true, 'player sends cam from /kirim (desktop)');
  await opFetch('/api/action', { type: 'playerCam', delay: 3, mode: 'manual', manual: 'Dreamocel', minHold: 0 });
  const camPage = await pub.newPage(); watch(camPage, 'cam'); await camPage.goto(H + '/cam?bg=1&debug=1&k=vk-1');
  await camPage.waitForFunction(() => !!document.querySelector('.frame canvas.on') && document.getElementById('box').classList.contains('in'), null, { timeout: 30000 });
  await sleep(2000);
  const cs = (await opFetch('/api/playercam/status', null)).j;
  const lag = cs.cams.find((c) => c.name === 'Dreamocel')?.lag;
  ok(cs.showing === 'Dreamocel' && Math.abs(lag - 3000) < 250, `cam overlay shows Dreamocel with ${lag} ms delay (set 3000)`);
  // mic: the fake device plays a beep; it comes out of the overlay after the delay
  const dm = cs.cams.find((c) => c.name === 'Dreamocel');
  ok(dm.mic && dm.audio === 'running', `overlay receives the mic (mic ${dm.mic}, audio ${dm.audio} ${dm.audioErr || ''})`);
  let heard = 0; for (let i = 0; i < 6 && !heard; i++) { await sleep(1000); heard = (await opFetch('/api/playercam/status', null)).j.cams.find((c) => c.name === 'Dreamocel').level; }
  ok(heard > 0.05, `mic audio comes out of the delay line (level ${heard})`);
  if (process.env.DBG) {
    console.log('cam pc:', await camPage.evaluate(async () => { const c = [...window.__cams.values()][0]; const o = []; (await c.conn.pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp') o.push(r.kind + ' ' + r.bytesReceived + ' pk ' + r.packetsReceived); }); return o.join(' | ') + ' transceivers ' + c.conn.pc.getTransceivers().map((t) => t.receiver.track.kind + ':' + t.currentDirection).join(','); }));
    console.log('sfu pcs:', await sfuPage.evaluate(async () => { const o = []; for (const pc of window.__pcs || []) { const x = []; (await pc.getStats()).forEach((r) => { if (/bound-rtp/.test(r.type)) x.push(r.type[0] + r.kind[0] + ':' + (r.bytesReceived ?? r.bytesSent)); }); o.push(x.join(' ')); } return o.join(' || '); }));
    console.log('kirim:', await pl.evaluate(() => document.getElementById('sMicTxt').textContent));
  }
  // a player without a cam: silhouette with the name
  await opFetch('/api/action', { type: 'playerCam', mode: 'manual', manual: 'NoCamPlayer', noCam: 'silhouette' }); await sleep(800);
  const sil = await camPage.evaluate(() => ({ on: document.getElementById('sil').classList.contains('on'), shown: document.getElementById('box').classList.contains('in'), name: document.getElementById('nm').textContent }));
  ok(sil.on && sil.shown && sil.name === 'NoCamPlayer', 'player without a cam shows the silhouette with the name (' + JSON.stringify(sil) + ')');
  await camPage.screenshot({ path: OUT + 'cam-silhouette.png' });
  await opFetch('/api/action', { type: 'playerCam', mode: 'manual', manual: 'Dreamocel' }); await sleep(800);
  // mic frames are stored encoded and played back after the delay
  const da = await camPage.evaluate(() => { const d = [...window.__cams.values()][0].au.da; return { recv: d.recv, played: d.played, late: d.late, err: d.err, buffered: d.frames.length ? (performance.now() - d.frames[0].t) / 1000 : 0 }; });
  ok(da.recv > 50 && da.played > 20 && !da.err, `mic: Opus frames received ${da.recv}, played after delay ${da.played}, late ${da.late} ${da.err}`);
  await opFetch('/api/action', { type: 'playerCam', mic: { name: 'Dreamocel', muted: true, vol: 0.5 } });
  await sleep(600);
  const g = await camPage.evaluate(() => [...window.__cams.values()][0].au.gain.gain.value);
  ok(g < 0.01, `per-player mute reaches the overlay (gain ${g.toFixed(3)})`);
  await opFetch('/api/action', { type: 'playerCam', mic: { name: 'Dreamocel', muted: false } });
  await sleep(600);
  const g2 = await camPage.evaluate(() => [...window.__cams.values()][0].au.gain.gain.value);
  ok(Math.abs(g2 - 0.5) < 0.05, `per-player volume reaches the overlay (gain ${g2.toFixed(3)})`);
  await opFetch('/api/action', { type: 'playerCam', audio: false }); await sleep(600);
  const g3 = await camPage.evaluate(() => [...window.__cams.values()][0].au.gain.gain.value);
  ok(g3 < 0.01, 'master audio off mutes everyone');
  await opFetch('/api/action', { type: 'playerCam', audio: true, mic: { name: 'Dreamocel', vol: 1 } });
  // horn sync: mark, wait, play -> delay = the gap, and the picture continues without waiting for the buffer to refill
  const kfs = async () => pl.evaluate(async () => { let k = null; for (const pc of window.__pcs || []) (await pc.getStats()).forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') k = r.keyFramesEncoded; }); return { k, st: !!window.RTCRtpScriptTransform }; });
  const kf1 = await kfs();
  const k0 = await camPage.evaluate(() => [...window.__cams.values()][0].dc.status(0).keys);
  await opFetch('/api/action', { type: 'playerCam', sync: 'mark', at: Date.now() });
  await sleep(7000);
  await opFetch('/api/action', { type: 'playerCam', sync: 'play', at: Date.now() });
  const syncDelay = JSON.parse((await anon('/api/state')).text).playerCam.delay;
  ok(Math.abs(syncDelay - 7) < 0.6, `horn sync sets the delay to the gap (${syncDelay} s for 7 s)`);
  await sleep(1500);
  const aSync = await camPage.evaluate(() => { const c = [...window.__cams.values()][0]; return { ...c.dc.status(7000), keys: c.dc.keys, frames: c.dc.frames.length }; });
  const kf2 = await kfs();
  ok(kf2.k - kf1.k >= 3, `player sends its own keyframe every 2 s (${kf2.k - kf1.k} in ~8.5 s)`);
  ok(aSync.keys > k0 + 1, `sender sends regular keyframes for seeking (${aSync.keys - k0} new keyframes in ~8 s)`);
  ok(aSync.showing && Math.abs(aSync.lag - syncDelay * 1000) < 900, `after sync the cam continues right away at the new delay (lag ${aSync.lag} ms, seeks ${aSync.seeks})`);
  const auS = await camPage.evaluate(async () => { const d = [...window.__cams.values()][0].au.da; const p0 = d.played; await new Promise((r) => setTimeout(r, 1500)); return { played: d.played - p0, late: d.late }; });
  ok(auS.played > 40, `mic continues after sync at the new delay (${auS.played} frames in 1.5 s, late ${auS.late})`);
  await opFetch('/api/action', { type: 'playerCam', delay: 3 });
  await sleep(1500);
  await opFetch('/api/action', { type: 'playerCam', resetBuffer: '' }); await sleep(800);
  const rs = await camPage.evaluate(() => { const c = [...window.__cams.values()][0]; return { buffered: c.dc.status(3000).buffered, audio: c.au.da.frames.length }; });
  ok(rs.buffered < 1.5 && rs.audio < 80, `reset buffer empties the delay buffer (${rs.buffered.toFixed(1)} s video, ${rs.audio} audio frames left)`);
  await sleep(4500);
  await camPage.screenshot({ path: OUT + 'cam.png' });
  ok((await anon('/api/playercam/status', { method: 'POST', body: '{}' })).status === 403, 'cam status needs the view key');
  ok((await anon('/api/cam/admin')).status === 401, 'cam keys need login');
  const cc = await op.newPage(); watch(cc, 'camcontrol'); await cc.goto(H + '/camcontrol'); await sleep(2500);
  ok(/Secret Cloudflare lengkap/.test(await cc.textContent('#srvInfo')), 'camcontrol reads server setup');
  await cc.click('#testConn'); await sleep(800); ok(/1 cam online/.test(await cc.textContent('#connRes')), 'camcontrol connection test');
  await sleep(2200);
  ok(await cc.evaluate(() => { const r = document.querySelector('#mics .mic[data-n="Dreamocel"]'); return !!r && !!r.querySelector('.mute'); }), 'camcontrol lists the mic with a mute button');
  await cc.click('#mics .mic[data-n="Dreamocel"] .mute'); await sleep(1500);
  ok((await anon('/api/state').then((r) => JSON.parse(r.text))).playerCam.mics.dreamocel.muted === true, 'mute button in camcontrol mutes the player');
  ok(/MUTED/.test(await cc.textContent('#mics .mic[data-n="Dreamocel"] .mute')), 'camcontrol shows MUTED');
  await cc.screenshot({ path: OUT + 'camcontrol.png', fullPage: true });
  await pl.screenshot({ path: OUT + 'kirim.png' });
  // team cam: a camera set as a team cam leaves /cam and shows on /teamcam with the team's name
  await opFetch('/api/action', { type: 'playerCam', teamCam: { left: 'Dreamocel', show: 'left', visible: true } });
  const tcPage = await pub.newPage(); watch(tcPage, 'teamcam'); await tcPage.goto(H + '/teamcam?bg=1&debug=1&k=vk-1');
  await tcPage.waitForFunction(() => !!document.querySelector('.vid canvas.on') && document.getElementById('box').classList.contains('in'), null, { timeout: 30000 });
  ok(true, 'team cam overlay shows the team camera');
  const tcName = await tcPage.textContent('#nm');
  ok(tcName === JSON.parse((await anon('/api/state')).text).teams.left.name, 'team cam shows the left team name (' + tcName + ')');
  let tst = null; for (let i = 0; i < 10; i++) { await sleep(800); tst = (await opFetch('/api/playercam/status', null)).j; if (!tst.cams.some((c) => c.name === "Dreamocel") && tst.team.showing === "Dreamocel") break; }
  ok(!tst.cams.some((c) => c.name === "Dreamocel") && tst.team.showing === 'Dreamocel', 'team camera leaves /cam and reports from /teamcam');
  await cc.reload(); await sleep(2500);
  ok(/siap/.test(await cc.textContent('#tcStL')), 'camcontrol team cam card shows the camera ready (' + await cc.textContent('#tcStL') + ')');
  await tcPage.screenshot({ path: OUT + 'teamcam.png' }); await cc.screenshot({ path: OUT + 'camcontrol-team.png', fullPage: true });
  const tcFull = await pub.newPage(); await tcFull.goto(H + '/teamcam?full=1&bg=1&k=vk-1');
  await tcFull.waitForFunction(() => !!document.querySelector('.vid canvas.on'), null, { timeout: 30000 });
  const fr = await tcFull.evaluate(() => { const r = document.querySelector('.vid canvas.on').getBoundingClientRect(); return [r.x, r.y, r.width, r.height, getComputedStyle(document.querySelector('.plate')).display]; });
  ok(fr[0] === 0 && fr[1] === 0 && Math.round(fr[2]) === 1920 && Math.round(fr[3]) === 1080 && fr[4] === 'none', 'team cam full 16:9 fills the source with no layout (' + fr.join(',') + ')');
  await tcFull.screenshot({ path: OUT + 'teamcam-full.png' }); await tcFull.close();
  await opFetch('/api/action', { type: 'playerCam', teamCam: { show: 'off' } }); await sleep(800);
  ok(!(await tcPage.evaluate(() => document.getElementById('box').classList.contains('in'))), 'team cam hides when set to Off');
  // operator disconnects the player: kirim stops by itself, the cam leaves the list
  const kr = await opFetch('/api/cam/kick', { name: '' });
  ok(kr.j.ok && kr.j.kicked.includes('Dreamocel'), 'disconnect-all reaches the cam relay (' + JSON.stringify(kr.j.kicked) + ')');
  let kicked = ''; for (let i = 0; i < 24 && !/DIHENTIKAN/.test(kicked); i++) { await sleep(500); kicked = await pl.textContent('#pill').catch(() => ''); }
  ok(/DIHENTIKAN/.test(kicked), `player's /kirim page stops after being disconnected (${kicked})`);
  const anonKick = await anon('/api/cam/kick', { method: 'POST', body: '{}' });
  ok(anonKick.status === 401, 'disconnecting players needs the operator login');
  await pg.screenshot({ path: OUT + 'control.png' });
// teams are separate per tournament
  {
    const pg2 = await (await browser.newContext()).newPage();
    await pg2.goto(H + '/login?next=/control'); await pg2.fill('input[name=password]', 'rahasia-operator'); await pg2.press('input[name=password]', 'Enter'); await pg2.waitForURL(/control/);
    const f = (u, b) => pg2.evaluate(async ([u, b]) => (await fetch(u, b === null ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json(), [u, b]);
    await f('/api/tournaments/switch', { id: 'direbattle-cup' });
    const cupTeams = (await f('/api/teams', null)).length;
    await f('/api/tournaments/switch', { id: 'direborn-match' });
    const dbTeams = (await f('/api/teams', null)).length;
    await f('/api/teams', { name: 'Direborn', tag: 'DB', players: ['Dreamocel', 'woMy', 'PotaT2', 'db-', 'dalul'] });
    const st1 = await f('/api/state', null);
    await f('/api/tournaments/switch', { id: 'direbattle-cup' });
    const cupAgain = await f('/api/teams', null);
    await f('/api/tournaments/switch', { id: 'direborn-match' });
    const dbAgain = await f('/api/teams', null);
    ok(cupTeams > 0 && dbTeams === 0 && dbAgain.length === 1 && dbAgain[0].name === 'Direborn' && cupAgain.length === cupTeams && !cupAgain.some((t) => t.name === 'Direborn'),
      `teams are per tournament (cup ${cupTeams}, direborn ${dbTeams} -> ${dbAgain.length}, cup again ${cupAgain.length})`);
    // league ticket import from the Teams page: paste a Dotabuff link, the browser asks OpenDota itself
    const now = Math.floor(Date.now() / 1000);
    await pg2.route('https://api.opendota.com/**', (route) => {
      const u = route.request().url();
      const body = /leagues\/88888\/teams$/.test(u) ? [] : /leagues\/88888\/matches$/.test(u) ? [{ match_id: 1, start_time: now - 3600, radiant_team_id: 201, dire_team_id: 202 }]
        : /teams\/301$/.test(u) ? { team_id: 301, name: 'Talon Esports', tag: 'TLN', logo_url: '' } : /teams\/301\/players$/.test(u) ? [{ account_id: 5001, name: 'Solo', games_played: 3, is_current_team_member: true }]
        : /teams\/201$/.test(u) ? { team_id: 201, name: 'Direborn', tag: 'DB', logo_url: '' } : /teams\/202$/.test(u) ? { team_id: 202, name: 'Yangon Galacticos', tag: 'YG', logo_url: '' } : /leagues\/88888$/.test(u) ? { name: 'New Ticket' }
        : /leagues\/99999\/teams$/.test(u) ? [{ team_id: 101, name: 'Direborn', tag: 'DB', logo_url: '', last_match_time: now - 86400, wins: 3, losses: 1 }, { team_id: 102, name: 'Resp Gaming', tag: 'RESP', logo_url: '', last_match_time: now - 3 * 86400, wins: 2, losses: 2 }, { team_id: 103, name: 'Old Team', tag: 'OLD', logo_url: '', last_match_time: now - 200 * 86400, wins: 1, losses: 5 }]
        : /leagues\/99999$/.test(u) ? { leagueid: 99999, name: 'EPL World Series SEA Test' }
        : /teams\/102\/players$/.test(u) ? [{ account_id: 1103, name: 'Starter A', games_played: 30, is_current_team_member: true }, { account_id: 2104, name: 'Starter B', games_played: 25, is_current_team_member: true }, { account_id: 3003, name: 'Former', games_played: 50, is_current_team_member: false }]
        : /teams\/101\/players$/.test(u) ? [{ account_id: 1102, name: 'Dreamocel', games_played: 30, is_current_team_member: true }] : null;
      return body ? route.fulfill({ json: body, headers: { 'access-control-allow-origin': '*' } }) : route.fulfill({ status: 404, body: '' });
    });
    await pg2.goto(H + '/teams'); await sleep(1200);
    await pg2.fill('#lgId', '88888'); await pg2.click('#lgFind'); await sleep(1500);
    const fromMatches = await pg2.$$eval('#lgList b', (x) => x.map((e) => e.textContent));
    ok(fromMatches.includes('Yangon Galacticos'), 'empty team list: teams come from the ticket matches (' + fromMatches.join(', ') + ')');
    await pg2.fill('#lgId', 'https://www.dotabuff.com/esports/leagues/99999-epl-world-series-sea'); await pg2.click('#lgFind'); await sleep(1500);
    const listed = await pg2.$$eval('#lgList input[type=checkbox]', (x) => x.length);
    ok(listed === 2 && /EPL World Series SEA Test/.test(await pg2.textContent('#lgName')), `pasted Dotabuff link lists the recent teams (${listed}, old team filtered out)`);
    await pg2.click('#lgAll'); await pg2.click('#lgImport'); await sleep(2500);
    await pg2.fill('#tmIds', 'https://www.dotabuff.com/esports/teams/301-talon-esports, https://www.dotabuff.com/esports/teams/302-yangon-galacticos'); await pg2.click('#tmAdd'); await sleep(2500);
    const byId = await f('/api/teams', null);
    ok(byId.some((t) => t.name === 'Talon Esports' && t.accountIds[0] === '5001') && byId.some((t) => t.name === 'Yangon Galacticos'), 'add teams by Dotabuff team link (OpenDota data, or the name from the link) — ' + byId.map((t) => t.name).join(', '));
    const afterLg = (await f('/api/teams', null)).filter((t) => !['Talon Esports', 'Yangon Galacticos'].includes(t.name));
    const resp = afterLg.find((t) => t.name === 'Resp Gaming');
    ok(resp && resp.players[0] === 'Starter A' && resp.accountIds[0] === '1103' && !resp.players.includes('Former') && afterLg.length === 2,
      `import adds the teams with current players + Steam IDs (${afterLg.map((t) => t.name).join(', ')})`);
    ok((await f('/api/stats', null)).leagueId === '99999', 'the tournament stats use the same ticket');
    ok(st1.tournamentInfo.theme === 'direborn' && st1.teams.left.name === 'TEAM A', `draft drops the other tournament's teams (${st1.teams.left.name} vs ${st1.teams.right.name})`);
    await f('/api/tournaments/switch', { id: 'direbattle-cup' });
  }
  
  
} catch (e) { fails++; results.push('FAIL crashed: ' + e.stack); }
console.log(results.join('\n'));
console.log(errs.length ? 'page errors:\n  ' + errs.slice(0, 20).join('\n  ') : 'no page errors');
console.log(fails ? `\n${fails} FAILED` : '\nall passed');

await browser.close();
process.exit(fails ? 1 : 0);
