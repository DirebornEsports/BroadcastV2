/* Replay (Draft control → On air): OBS's own Replay Buffer, driven over obs-websocket (built into OBS 28+) from the
   browser on the OBS PC. One click saves the buffer, loads that file into the replay Media Source, jumps to N seconds
   before "now" and switches to the replay scene; "Kembali ke live" switches back. Settings stay on this device. */
(function () {
  'use strict';
  const first = document.querySelector('main > [data-pane~="air"]');
  if (!first || document.getElementById('rpCard')) return;
  const K = 'dbo.replay';
  const cfg = Object.assign({ url: 'ws://127.0.0.1:4455', pass: '', replayScene: '', liveScene: '', source: '' }, JSON.parse(localStorage.getItem(K) || '{}'));
  const save = () => localStorage.setItem(K, JSON.stringify(cfg));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const card = document.createElement('section');
  card.className = 'card ux-air'; card.id = 'rpCard'; card.dataset.pane = 'air'; card.style.order = '-1';
  card.innerHTML = `<h2>Replay</h2>
    <div class="btns" style="justify-content:flex-start;flex-wrap:wrap">
      <button data-back="30">−30 dtk</button><button data-back="60">−1 menit</button><button data-back="120">−2 menit</button><button data-back="300">−5 menit</button>
      <button class="primary" id="rpLive">Kembali ke live</button>
    </div>
    <div class="ignow" id="rpNow" style="margin-top:12px">Belum tersambung ke OBS</div>
    <details style="margin-top:12px"><summary>Sambungan OBS</summary>
      <div class="btns" style="justify-content:flex-start;align-items:flex-end;flex-wrap:wrap;margin-top:10px">
        <label style="width:200px">Alamat websocket<input id="rpUrl"></label>
        <label style="width:160px">Password<input id="rpPass" type="password" autocomplete="off"></label>
        <label style="width:180px">Scene replay<select id="rpScene"></select></label>
        <label style="width:180px">Scene live<select id="rpLiveScene"></select></label>
        <label style="width:200px">Media source replay<select id="rpSrc"></select></label>
        <button id="rpConnect">Sambungkan</button>
      </div>
    </details>
    <p class="hint">Sekali setting di OBS: <b>Tools → WebSocket Server Settings</b> → aktifkan (port 4455, isi password).
      <b>Settings → Output → Replay Buffer</b> → aktifkan, <i>Maximum Replay Time</i> 300 detik.
      Buat scene <b>Replay</b> berisi <i>Media Source</i> (kosongkan saja, diisi otomatis) + Browser source <code>/replay</code> 1920 × 1080 untuk label REPLAY.
      Lalu pilih scene dan source-nya di atas.</p>`;
  first.parentElement.insertBefore(card, first);
  const $ = (id) => document.getElementById(id);
  const now = (t, bad) => { $('rpNow').textContent = t; $('rpNow').style.color = bad ? 'var(--danger, #e3122d)' : ''; };
  $('rpUrl').value = cfg.url; $('rpPass').value = cfg.pass;

  // ---------- obs-websocket v5 client ----------
  let ws = null, ready = false, nextId = 1, retry = null;
  const pending = new Map(), waiters = [];
  const b64sha = async (s) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))));
  function req(type, data) {
    if (!ready) return Promise.reject(new Error('OBS belum tersambung'));
    const id = String(nextId++);
    ws.send(JSON.stringify({ op: 6, d: { requestType: type, requestId: id, requestData: data || {} } }));
    return new Promise((ok, no) => {
      pending.set(id, { ok, no });
      setTimeout(() => { if (pending.delete(id)) no(new Error(type + ': OBS tidak menjawab')); }, 8000);
    });
  }
  const waitEvent = (type, ms) => new Promise((ok) => {
    const w = { type, ok }; waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); ok(null); } }, ms);
  });
  function connect() {
    clearTimeout(retry);
    if (ws) { ws.onclose = null; ws.close(); }
    ready = false; now('Menyambung ke OBS…');
    try { ws = new WebSocket(cfg.url); } catch (e) { now('Alamat websocket salah', true); return; }
    ws.onmessage = async (e) => {
      const m = JSON.parse(e.data);
      if (m.op === 0) {                                              // Hello: identify (with the password when OBS asks for one)
        const a = m.d.authentication, d = { rpcVersion: 1, eventSubscriptions: (1 << 2) | (1 << 6) };   // Scenes + Outputs
        if (a) d.authentication = await b64sha((await b64sha(cfg.pass + a.salt)) + a.challenge);
        ws.send(JSON.stringify({ op: 1, d }));
      } else if (m.op === 2) { ready = true; onReady(); }
      else if (m.op === 5) {
        for (const w of waiters.filter((x) => x.type === m.d.eventType)) { waiters.splice(waiters.indexOf(w), 1); w.ok(m.d.eventData || {}); }
        if (m.d.eventType === 'CurrentProgramSceneChanged') showScene(m.d.eventData.sceneName);
      } else if (m.op === 7) {
        const p = pending.get(m.d.requestId); if (!p) return;
        pending.delete(m.d.requestId);
        if (m.d.requestStatus.result) p.ok(m.d.responseData || {}); else p.no(new Error(m.d.requestStatus.comment || ('kode ' + m.d.requestStatus.code)));
      }
    };
    ws.onclose = (e) => {
      ready = false;
      now(e.code === 4009 ? 'Password OBS salah' : 'OBS tidak tersambung (OBS mati atau WebSocket belum diaktifkan) · coba lagi tiap 5 detik', true);
      if (e.code !== 4009) retry = setTimeout(connect, 5000);
    };
  }
  function fill(sel, names, cur) {
    sel.innerHTML = '<option value="">— pilih —</option>' + names.map((n) => `<option${n === cur ? ' selected' : ''}>${esc(n)}</option>`).join('');
  }
  let liveName = '';
  function showScene(n) {
    liveName = n;
    if (n === cfg.replayScene) now('Sedang REPLAY · klik "Kembali ke live" untuk kembali');
    else if (ready) now('Tersambung ke OBS · buffer replay siap');
  }
  async function onReady() {
    try {
      const sc = await req('GetSceneList'), inp = await req('GetInputList', { inputKind: 'ffmpeg_source' });
      fill($('rpScene'), sc.scenes.map((s) => s.sceneName).reverse(), cfg.replayScene);
      fill($('rpLiveScene'), sc.scenes.map((s) => s.sceneName).reverse(), cfg.liveScene);
      fill($('rpSrc'), inp.inputs.map((i) => i.inputName), cfg.source);
      const rb = await req('GetReplayBufferStatus');
      if (!rb.outputActive) await req('StartReplayBuffer');
      showScene(sc.currentProgramSceneName);
    } catch (e) {
      now(/replay/i.test(e.message) || /StartReplayBuffer/.test(e.message) ? 'Replay Buffer belum aktif di OBS (Settings → Output → Replay Buffer)' : e.message, true);
    }
  }

  // ---------- actions ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function replay(sec, label) {
    if (!cfg.replayScene || !cfg.source) { now('Pilih scene replay dan media source dulu (Sambungan OBS)', true); card.querySelector('details').open = true; return; }
    try {
      now('Menyimpan replay…');
      const saved = waitEvent('ReplayBufferSaved', 6000);
      await req('SaveReplayBuffer');
      const ev = (await saved) || (await req('GetLastReplayBufferReplay'));
      const file = ev.savedReplayPath;
      if (!file) throw new Error('OBS tidak memberi file replay');
      await req('SetInputSettings', { inputName: cfg.source, inputSettings: { is_local_file: true, local_file: file, looping: false, restart_on_activate: true, close_when_inactive: true } });
      if (!cfg.liveScene && liveName && liveName !== cfg.replayScene) { cfg.liveScene = liveName; save(); }   // "back to live" = where we came from
      await req('SetCurrentProgramScene', { sceneName: cfg.replayScene });
      let dur = 0;                                                   // the file opens when the scene goes live
      for (let i = 0; i < 50 && !dur; i++) {
        const st = await req('GetMediaInputStatus', { inputName: cfg.source });
        if (st.mediaDuration > 0) dur = st.mediaDuration; else await sleep(100);
      }
      if (dur) await req('SetMediaInputCursor', { inputName: cfg.source, mediaCursor: Math.max(0, dur - sec * 1000) });
      now(`REPLAY ${label} sebelum sekarang` + (dur && dur < sec * 1000 ? ` (buffer cuma ${Math.round(dur / 1000)} dtk, diputar dari awal)` : ''));
      // Direborn Studio: the camera bridge on this PC deletes older replay files (they are hundreds of MB each)
      if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) fetch('http://127.0.0.1:8787/studio/replay-clean', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: file }) }).catch(() => {});
    } catch (e) { now('Replay gagal: ' + e.message, true); }
  }
  card.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-back]');
    if (b) replay(Number(b.dataset.back), b.textContent.replace('−', ''));
  });
  $('rpLive').onclick = async () => {
    if (!cfg.liveScene) { now('Pilih scene live dulu (Sambungan OBS)', true); card.querySelector('details').open = true; return; }
    try { await req('SetCurrentProgramScene', { sceneName: cfg.liveScene }); } catch (e) { now(e.message, true); }
  };
  for (const [id, k] of [['rpScene', 'replayScene'], ['rpLiveScene', 'liveScene'], ['rpSrc', 'source']]) $(id).onchange = () => { cfg[k] = $(id).value; save(); };
  $('rpConnect').onclick = () => { cfg.url = $('rpUrl').value.trim() || 'ws://127.0.0.1:4455'; cfg.pass = $('rpPass').value; save(); connect(); };
  connect();
})();
