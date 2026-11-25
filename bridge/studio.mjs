// Direborn Studio (LAN): what the bridge does when it runs inside the Studio app.
//  - PINs: one 4-digit PIN per player and per team cam, from the Hub's team database
//  - discovery: Player apps find this PC with a UDP broadcast (no IP typing)
//  - receivers: one studio-recv per camera slot, all on one shared delay
//  - fixed OBS ports per slot: 5001-5005 left players, 5006-5010 right players, 5011/5012 team cams,
//    5000 = "auto": the cam of the player the observer has selected (GSI), switched on a keyframe
import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';

const HUB = process.env.HUB_URL || 'http://127.0.0.1:8080';
const DATA = process.env.STUDIO_DATA || path.resolve('studio-data');
const RECV = process.env.RECV_EXE || path.resolve('studio/target/release/studio-recv.exe');
const DISCOVERY_PORT = 8789;
fs.mkdirSync(DATA, { recursive: true });
const PINS_FILE = path.join(DATA, 'pins.json');
const DELAY_FILE = path.join(DATA, 'delay.txt');
if (!fs.existsSync(DELAY_FILE)) fs.writeFileSync(DELAY_FILE, '10');

// ---------- PINs ----------
let pins = (() => { try { return JSON.parse(fs.readFileSync(PINS_FILE, 'utf8')); } catch { return []; } })();   // [{pin, name, team, kind}]
const savePins = () => fs.writeFileSync(PINS_FILE, JSON.stringify(pins, null, 1));
export const pinFor = (pin) => pins.find((p) => p.pin === String(pin));
export const pinsActive = () => pins.length > 0;
const teamCamName = (t) => `${t.tag || t.name} TEAM`;

async function hubGet(p) {
  const r = await fetch(HUB + p);
  if (!r.ok) throw new Error(`Hub ${p}: HTTP ${r.status}`);
  return r.json();
}

/** Give every player and team cam of the active tournament a PIN; existing PINs stay the same. */
async function syncPins() {
  const db = await hubGet('/api/teams');
  const teams = Array.isArray(db) ? db : db.teams || [];
  const want = [];
  for (const t of teams) {
    for (const n of t.players || []) if (n && n.trim()) want.push({ name: n.trim(), team: t.name, kind: 'player' });
    want.push({ name: teamCamName(t), team: t.name, kind: 'team' });
  }
  const used = new Set(pins.map((p) => p.pin));
  for (const w of want) {
    if (pins.some((p) => p.name.toLowerCase() === w.name.toLowerCase())) continue;
    let pin;
    do pin = String(1000 + Math.floor(Math.random() * 9000)); while (used.has(pin));
    used.add(pin);
    pins.push({ pin, ...w });
  }
  savePins();
  return pins;
}

// ---------- slots (fixed OBS ports) ----------
const SLOT_NAMES = ['L1', 'L2', 'L3', 'L4', 'L5', 'R1', 'R2', 'R3', 'R4', 'R5', 'LT', 'RT'];
const PUBLIC_PORT = (i) => 5001 + i, INTERNAL_PORT = (i) => 6001 + i, AUTO_PORT = 5000;
const slots = SLOT_NAMES.map((slot, i) => ({ slot, i, name: '', proc: null, status: null, log: [] }));
let hubState = null;

// operator choices, kept across restarts:
//   overrides: slot -> player name typed/picked by hand ('' or missing = follow the teams in draft control)
//   auto: what port 5000 shows: 'gsi' (observer's selected hero), 'manual' (one slot) or 'off'
const SETTINGS_FILE = path.join(DATA, 'studio.json');
const settings = { overrides: {}, auto: { mode: 'gsi', slot: 'L1' }, ...(() => { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; } })() };
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1));

function wantedNames(st) {
  const L = st.teams.left, R = st.teams.right;
  const players = (t) => [0, 1, 2, 3, 4].map((k) => (t.players && t.players[k]) || '');
  const fromTeams = [...players(L), ...players(R), L.name ? teamCamName(L) : '', R.name ? teamCamName(R) : ''];
  return fromTeams.map((n, i) => settings.overrides[SLOT_NAMES[i]] || n);
}

const SNAP_DIR = path.join(DATA, 'snap');
fs.mkdirSync(SNAP_DIR, { recursive: true });
const snapFile = (s) => path.join(SNAP_DIR, `${s.slot}.h264`);

function startReceiver(s) {
  const args = ['--bridge', `http://127.0.0.1:${process.env.PORT || 8787}`, '--name', s.name, '--delay', fs.readFileSync(DELAY_FILE, 'utf8').trim(),
    '--delay-file', DELAY_FILE, '--snapshot', snapFile(s), '--out', `udp://127.0.0.1:${INTERNAL_PORT(s.i)}?pkt_size=1316`];
  try { fs.unlinkSync(snapFile(s)); } catch {}   // never show the previous player's picture
  const p = spawn(RECV, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  s.proc = p; s.status = null; s.log = [];
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, k); buf = buf.slice(k + 1); try { s.status = JSON.parse(l); } catch {} } });
  p.stderr.on('data', (d) => { s.log.push(...String(d).split(/\r?\n/).filter(Boolean)); s.log = s.log.slice(-8); });
  p.on('exit', () => { if (s.proc === p) { s.proc = null; s.status = null; } });
}
function stopReceiver(s) {
  if (!s.proc) return;
  const pid = s.proc.pid; s.proc = null; s.status = null;
  spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });   // the receiver's ffmpeg child goes too
}

/** Keep one receiver per slot whose name is set; restart a slot when its name changes or its receiver died. */
function reconcile() {
  if (!hubState) return;
  const names = wantedNames(hubState);
  for (const s of slots) {
    const n = names[s.i].trim();
    if (n !== s.name) { stopReceiver(s); s.name = n; }
    if (s.name && !s.proc) startReceiver(s);
  }
}

// ---------- relay: internal port -> public port, and the selected one -> auto port ----------
const out = dgram.createSocket('udp4');
let autoSlot = -1, pendingSlot = -1;
// a datagram holds 7 TS packets; ffmpeg sets random_access_indicator on the packet that starts a keyframe
// offset of the TS packet that starts a video keyframe in this datagram, or -1. ffmpeg's MPEG-TS puts video on
// PID 0x100 and marks every audio packet as random-access too, so only the video PID counts.
const VIDEO_PID = 0x100;
const keyframeAt = (b) => {
  for (let o = 0; o + 188 <= b.length; o += 188) {
    if (b[o] !== 0x47 || (((b[o + 1] & 0x1f) << 8) | b[o + 2]) !== VIDEO_PID) continue;
    const afc = (b[o + 3] >> 4) & 3;
    if ((afc === 2 || afc === 3) && b[o + 4] > 0 && (b[o + 5] & 0x40)) return o;
  }
  return -1;
};
for (const s of slots) {
  const sock = dgram.createSocket({ type: 'udp4', recvBufferSize: 8 << 20 });
  sock.on('message', (m) => {
    out.send(m, PUBLIC_PORT(s.i), '127.0.0.1');
    if (pendingSlot === s.i) {
      // switch only where the new cam can be decoded, and from that exact TS packet on
      const k = keyframeAt(m);
      if (k >= 0) { autoSlot = s.i; pendingSlot = -1; out.send(m.subarray(k), AUTO_PORT, '127.0.0.1'); return; }
    }
    if (autoSlot === s.i) out.send(m, AUTO_PORT, '127.0.0.1');
  });
  sock.on('error', (e) => console.error(`[relay] ${s.slot}: ${e.message}`));
  sock.bind(INTERNAL_PORT(s.i), '127.0.0.1');
}

function follow(st) {
  const a = settings.auto;
  if (a.mode === 'off') { autoSlot = -1; pendingSlot = -1; return; }
  let i;
  if (a.mode === 'manual') i = SLOT_NAMES.indexOf(a.slot);
  else {
    const sel = st.camSel && st.camSel.name ? String(st.camSel.name).toLowerCase() : '';
    i = sel ? slots.findIndex((s) => s.name && s.name.toLowerCase() === sel) : -1;
  }
  if (i < 0) return;                                          // nobody selected: keep the last cam
  if (i !== autoSlot && i !== pendingSlot) pendingSlot = i;
}

// ---------- live check pictures ("Cek cam"): the newest keyframe each receiver saw, decoded on demand ----------
const snapCache = new Map();   // slot -> { at, jpg }
function snapshot(s) {
  const f = snapFile(s);
  let st; try { st = fs.statSync(f); } catch { return Promise.resolve(null); }
  if (Date.now() - st.mtimeMs > 10000) return Promise.resolve(null);   // no keyframe for 10 s: the cam is gone
  const c = snapCache.get(s.slot);
  if (c && Date.now() - c.at < 1500) return Promise.resolve(c.jpg);
  return new Promise((ok) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-f', 'h264', '-i', f, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { windowsHide: true });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', () => ok(null));
    p.on('close', () => { const jpg = chunks.length ? Buffer.concat(chunks) : null; if (jpg) snapCache.set(s.slot, { at: Date.now(), jpg }); ok(jpg); });
  });
}

// cams the players are sending right now, from server.mjs
let onlineCams = () => [];
export function setOnline(fn) { onlineCams = fn; }

// ---------- Hub polling ----------
let hubError = '';
async function poll() {
  try { hubState = await hubGet('/api/state'); hubError = ''; reconcile(); follow(hubState); }
  catch (e) { hubError = e.message; }
}
setInterval(poll, 500);
poll();

// ---------- discovery ----------
const disco = dgram.createSocket({ type: 'udp4', reuseAddr: true });
disco.on('message', (m, r) => { if (String(m).trim() === 'DIREBORN-CAM?') disco.send(`DIREBORN-CAM ${process.env.PORT || 8787}`, r.port, r.address); });
disco.on('error', (e) => console.error('[discovery]', e.message));
disco.bind(DISCOVERY_PORT);

// ---------- HTTP (called from server.mjs; null = not ours) ----------
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const DASH = fs.readFileSync(new URL('./dashboard.html', import.meta.url));

export async function studioRoute(req, url, body) {
  const p = url.pathname;
  if (req.method === 'GET' && p.startsWith('/pin/')) {
    const x = pinFor(p.slice(5));
    return x ? [200, 'application/json', JSON.stringify({ name: x.name, team: x.team, kind: x.kind })] : [404, 'text/plain', 'PIN salah'];
  }
  if (!p.startsWith('/studio') && p !== '/') return null;
  if (!isLocal(req)) return [403, 'text/plain', 'hanya dari PC studio'];   // the dashboard is for the operator at this PC
  if (p === '/') return [200, 'text/html; charset=utf-8', DASH];
  if (p === '/studio/state') {
    return [200, 'application/json', JSON.stringify({
      hubError, delay: Number(fs.readFileSync(DELAY_FILE, 'utf8')) || 0, autoSlot: autoSlot >= 0 ? SLOT_NAMES[autoSlot] : '', autoPort: AUTO_PORT,
      selected: hubState && hubState.camSel ? hubState.camSel.name : '',
      slots: slots.map((s) => ({ slot: s.slot, name: s.name, port: PUBLIC_PORT(s.i), running: !!s.proc, status: s.status, log: s.log.slice(-3),
        manual: !!settings.overrides[s.slot],
        pin: (pins.find((x) => s.name && x.name.toLowerCase() === s.name.toLowerCase()) || {}).pin || '' })),
      auto: settings.auto,
      online: onlineCams(),
      teams: hubState ? { left: hubState.teams.left.name || '', right: hubState.teams.right.name || '' } : { left: '', right: '' },
      pins,
    })];
  }
  if (p === '/studio/slot' && req.method === 'POST') {
    const b = JSON.parse(body || '{}');
    if (!SLOT_NAMES.includes(b.slot)) return [400, 'text/plain', 'slot tidak ada'];
    const n = String(b.name || '').trim().slice(0, 40);
    if (n) settings.overrides[b.slot] = n; else delete settings.overrides[b.slot];
    saveSettings();
    return [204, 'text/plain', ''];                              // reconcile() swaps the receiver within 0.5 s
  }
  if (p === '/studio/auto' && req.method === 'POST') {
    const b = JSON.parse(body || '{}');
    if (!['gsi', 'manual', 'off'].includes(b.mode) || (b.slot && !SLOT_NAMES.includes(b.slot))) return [400, 'text/plain', 'mode / slot salah'];
    settings.auto = { mode: b.mode, slot: b.slot || settings.auto.slot };
    saveSettings();
    if (hubState) follow(hubState);
    return [204, 'text/plain', ''];
  }
  if (p.startsWith('/studio/snap/')) {
    const s = slots.find((x) => x.slot === p.slice('/studio/snap/'.length));
    const jpg = s && s.name ? await snapshot(s) : null;
    return jpg ? [200, 'image/jpeg', jpg, { 'cache-control': 'no-store' }] : [404, 'text/plain', 'belum ada gambar'];
  }
  if (p === '/studio/delay' && req.method === 'POST') {
    const d = Number(JSON.parse(body || '{}').delay);
    if (!Number.isFinite(d) || d < 0 || d > 1020) return [400, 'text/plain', 'delay 0-1020'];
    fs.writeFileSync(DELAY_FILE, String(Math.round(d * 10) / 10));
    return [204, 'text/plain', ''];
  }
  if (p === '/studio/pins/sync' && req.method === 'POST') return [200, 'application/json', JSON.stringify(await syncPins())];
  if (p === '/studio/restart' && req.method === 'POST') {
    const s = slots.find((x) => x.slot === JSON.parse(body || '{}').slot);
    if (s) stopReceiver(s);                                      // reconcile() starts it again within 0.5 s
    return [204, 'text/plain', ''];
  }
  return [404, 'text/plain', 'tidak ada'];
}

export function stopAll() { for (const s of slots) stopReceiver(s); }
