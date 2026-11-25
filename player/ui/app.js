// Direborn Cam window: cek kebutuhan -> kamera & mic -> PIN -> live. The Rust side (src-tauri) runs ffmpeg.
const { invoke, Channel } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const ENC_LABEL = { h264_nvenc: 'GPU: NVIDIA', h264_amf: 'GPU: AMD', h264_qsv: 'GPU: Intel', libx264: 'CPU' };
let cfg = {};
let me = null;          // { name, team, kind } from the studio
let media = null;       // preview stream + audio context, released before ffmpeg opens the camera

function show(id) {
  for (const s of document.querySelectorAll('section')) s.hidden = s.id !== id;
  const order = ['kamera', 'pin', 'live'], at = order.indexOf(id);
  for (const li of $('steps').children) { const i = order.indexOf(li.dataset.step); li.className = i === at ? 'on' : i < at ? 'done' : ''; }
}
const save = () => invoke('save_config', { json: JSON.stringify(cfg) });

// ---------- 1. cek kebutuhan ----------
async function check() {
  show('cek');
  const p = await invoke('check_ffmpeg');
  if (p) return cameras();
  $('cek-msg').textContent = 'ffmpeg belum ada.';
  $('cek-missing').hidden = false;
}
$('recheck').onclick = check;
$('install').onclick = async () => {
  const out = $('install-out');
  let raw = '';
  out.hidden = false; out.textContent = 'Menjalankan winget...';
  $('install').disabled = $('recheck').disabled = true;
  const ch = new Channel();
  // winget redraws its progress bar with \r: keep only the last state of every line
  ch.onmessage = (t) => { raw += t; out.textContent = raw.split(/\r?\n/).map((l) => l.split('\r').filter(Boolean).pop() || '').join('\n'); out.scrollTop = 1e9; };
  try {
    const ok = await invoke('install_ffmpeg', { out: ch });
    out.textContent += ok ? '\n\nSelesai. Mengecek lagi...' : '\n\nwinget gagal (lihat pesan di atas).';
  } catch (e) { out.textContent += '\n\n' + e; }
  $('install').disabled = $('recheck').disabled = false;
  check();
};

// ---------- 2. kamera & mic ----------
async function cameras() {
  show('kamera');
  invoke('encoder').then((e) => { $('enc').textContent = ENC_LABEL[e] || e; }, (e) => { $('enc').textContent = String(e); $('enc').className = 'err'; });
  const d = await invoke('devices').catch((e) => { alert(e); return { cameras: [], mics: [] }; });
  const fill = (sel, names, first, want) => {
    sel.innerHTML = '';
    if (first) sel.add(new Option(first, ''));
    for (const n of names) sel.add(new Option(n, n));
    if (names.includes(want)) sel.value = want;
  };
  fill($('cam'), d.cameras, d.cameras.length ? '' : '(tidak ada kamera)', cfg.camera);
  fill($('mic'), d.mics, 'tanpa mic', cfg.mic);
  // returning player with a saved setup that still exists: offer one-click start
  const ready = cfg.camera && cfg.pin && cfg.addr && d.cameras.includes(cfg.camera);
  $('quick').hidden = !ready;
  if (ready) $('quick-sub').textContent = `${cfg.camera} · PIN ${cfg.pin} · ${cfg.addr}`;
  $('cam-msg').textContent = '';
  preview();
}
$('cam').onchange = $('mic').onchange = preview;
$('refresh-dev').onclick = cameras;

function release() {
  if (!media) return;
  for (const t of media.stream.getTracks()) t.stop();
  if (media.ctx) media.ctx.close();
  cancelAnimationFrame(media.raf);
  $('video').srcObject = null; $('level').style.width = '0';
  media = null;
}

// dshow name -> browser device: same name, or the name plus a " (vid:pid)" style suffix
function match(list, kind, name) {
  const l = list.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return l.find((d) => d.label === name) || l.find((d) => d.label.startsWith(name)) || l.find((d) => d.label.includes(name));
}

async function preview() {
  release();
  const cam = $('cam').value, mic = $('mic').value;
  $('preview-msg').textContent = '';
  const my = media = { stream: new MediaStream(), raf: 0 };
  if (cam === 'test') $('preview-msg').textContent = 'Pola tes ffmpeg (dev): tidak ada preview';
  if (!cam && !mic) return;
  try {
    // device labels stay empty until one getUserMedia call has been allowed
    let list = await navigator.mediaDevices.enumerateDevices();
    if (!list.some((d) => d.label)) {
      (await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).catch(() => navigator.mediaDevices.getUserMedia({ video: true }))).getTracks().forEach((t) => t.stop());
      list = await navigator.mediaDevices.enumerateDevices();
    }
    if (my !== media) return;   // the user picked something else meanwhile
    const v = cam && cam !== 'test' && match(list, 'videoinput', cam);
    const a = mic && mic !== 'test' && match(list, 'audioinput', mic);
    if (cam && cam !== 'test' && !v) $('preview-msg').textContent = 'Preview tidak tersedia untuk kamera ini (kiriman tetap bisa jalan)';
    if (!v && !a) return;
    const s = await navigator.mediaDevices.getUserMedia({ video: v ? { deviceId: { exact: v.deviceId } } : false, audio: a ? { deviceId: { exact: a.deviceId } } : false });
    if (my !== media) { s.getTracks().forEach((t) => t.stop()); return; }
    my.stream = s;
    if (v) $('video').srcObject = s;
    if (a) meter(my, s);
  } catch (e) {
    $('preview-msg').textContent = 'Preview gagal: ' + (e.message || e) + ' (kamera dipakai aplikasi lain?)';
  }
}

function meter(my, s) {
  my.ctx = new AudioContext();
  const an = my.ctx.createAnalyser();
  an.fftSize = 512;
  my.ctx.createMediaStreamSource(s).connect(an);
  const buf = new Float32Array(an.fftSize);
  const tick = () => {
    an.getFloatTimeDomainData(buf);
    let peak = 0; for (const x of buf) peak = Math.max(peak, Math.abs(x));
    $('level').style.width = Math.min(100, peak * 100) + '%';
    my.raf = requestAnimationFrame(tick);
  };
  tick();
}

$('quick').onclick = () => { release(); pinScreen(true); };
$('to-pin').onclick = () => {
  if (!$('cam').value) { $('cam-msg').textContent = 'Pilih kamera dulu'; return; }
  cfg.camera = $('cam').value; cfg.mic = $('mic').value; save();
  release();
  pinScreen();
};

// ---------- 3. PIN ----------
function pinScreen(auto) {
  show('pin');
  $('pin-in').value = cfg.pin || '';
  $('addr').value = cfg.addr || '';
  $('addr-box').hidden = true; $('edit-addr').hidden = false;
  $('pin-msg').textContent = ''; $('pin-msg').className = '';
  $('pin-in').focus();
  if (auto) return $('go').onclick();
  find();
}
async function find() {
  const m = $('studio-msg');
  m.className = 'status'; m.textContent = 'Mencari studio di jaringan…';
  const a = await invoke('find_studio');
  if (a) { $('addr').value = a; m.className = 'status ok'; m.textContent = 'Studio ketemu · ' + a; }
  else if ($('addr').value) { m.className = 'status ok'; m.textContent = 'Pakai alamat terakhir · ' + $('addr').value; }
  else { m.className = 'status bad'; m.textContent = 'Studio tidak ketemu otomatis. Isi IP studio.'; $('addr-box').hidden = false; $('edit-addr').hidden = true; }
}
$('find').onclick = find;
$('edit-addr').onclick = () => { $('addr-box').hidden = false; $('edit-addr').hidden = true; $('addr').focus(); };
$('pin-in').oninput = () => { const v = $('pin-in').value.replace(/\D/g, '').slice(0, 4); $('pin-in').value = v; if (v.length === 4) $('go').onclick(); };
$('pin-in').onkeydown = $('addr').onkeydown = (e) => { if (e.key === 'Enter') $('go').onclick(); };
$('back-cam').onclick = cameras;

let checking = false;
$('go').onclick = async () => {
  if (checking) return;
  const pin = $('pin-in').value.trim();
  let addr = $('addr').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const msg = $('pin-msg');
  msg.className = 'err';
  if (!/^\d{4}$/.test(pin)) { msg.textContent = 'PIN harus 4 angka'; return; }
  if (!addr) { msg.textContent = 'Isi IP studio'; return; }
  if (!/:\d+$/.test(addr)) addr += ':8787';
  msg.className = ''; msg.textContent = 'Mengecek PIN…';
  checking = $('go').disabled = true;
  try {
    const r = await fetch(`http://${addr}/pin/${pin}`, { signal: AbortSignal.timeout(4000) });
    if (r.status === 404) { msg.className = 'err'; msg.textContent = 'PIN salah. Cek lagi ke operator.'; $('pin-in').select(); return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    me = await r.json();
  } catch (e) {
    msg.className = 'err'; msg.textContent = `Studio ${addr} tidak bisa dihubungi (${e.message || e})`;
    $('addr-box').hidden = false; $('edit-addr').hidden = true; return;
  } finally { checking = $('go').disabled = false; }
  cfg.pin = pin; cfg.addr = addr; save();
  live();
};

// ---------- 4. live ----------
const STATE = { connecting: 'Menyambung ke studio...', retry: 'Koneksi putus, sambung ulang dalam 3 detik...', stopped: 'Berhenti' };
async function live() {
  show('live');
  $('who').textContent = me.name;
  $('team').textContent = me.team || '';
  $('live-addr').textContent = cfg.addr;
  $('log').textContent = '';
  $('state').textContent = 'Menyiapkan encoder…'; $('state').className = 'pill';
  $('stop').hidden = false; $('again').hidden = $('back-pin').hidden = true;
  for (const id of ['frame', 'kbps', 'fps']) $(id).textContent = '-';
  $('mon-msg').hidden = false; $('mon-msg').textContent = 'Menunggu gambar...';
  $('mic-none').hidden = !!cfg.mic; $('mon-level').parentNode.hidden = !cfg.mic; $('mon-level').style.width = '0';
  const lines = [];
  const ch = new Channel();
  ch.onmessage = (m) => {
    if (m.log) { lines.push(m.log); $('log').textContent = lines.slice(-8).join('\n'); }
    if (m.mic) $('mon-level').style.width = Math.min(100, m.mic.peak * 100) + '%';
    if (m.kbps !== undefined) $('kbps').textContent = m.kbps;
    if (m.reconnects !== undefined) $('reconnects').textContent = m.reconnects;
    if (m.state === 'sending') { $('frame').textContent = m.frame; $('fps').textContent = m.fps.toFixed(1); }
    if (m.state) { $('state').textContent = m.state === 'sending' ? 'Live ke studio' : STATE[m.state]; $('state').className = 'pill ' + m.state; }
    if (m.state && m.state !== 'sending') $('fps').textContent = '-';
    if (m.state === 'stopped') {
      $('stop').hidden = true; $('again').hidden = $('back-pin').hidden = false;
      $('mon-msg').hidden = false; $('mon-msg').textContent = 'Berhenti';
    }
  };
  // what ffmpeg sends, as small JPEGs (~4 a second): the camera itself is held by ffmpeg
  const pv = new Channel();
  let url = '';
  pv.onmessage = (buf) => {
    const u = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
    $('mon-img').src = u; $('mon-msg').hidden = true;
    if (url) URL.revokeObjectURL(url);
    url = u;
  };
  try {
    const enc = await invoke('start', { camera: cfg.camera, mic: cfg.mic, addr: cfg.addr, pin: cfg.pin, events: ch, preview: pv });
    $('live-enc').textContent = ENC_LABEL[enc] || enc;
  } catch (e) {
    $('state').textContent = 'Gagal mulai: ' + e; $('state').className = 'pill retry';
    $('stop').hidden = true; $('again').hidden = $('back-pin').hidden = false;
  }
}
$('stop').onclick = () => { $('state').textContent = 'Menghentikan...'; invoke('stop'); };
$('again').onclick = live;
$('back-pin').onclick = cameras;

invoke('load_config').then((t) => { try { cfg = JSON.parse(t); } catch { cfg = {}; } check(); });
