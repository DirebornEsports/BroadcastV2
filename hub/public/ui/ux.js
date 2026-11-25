/* Operator UX layer (phase 4, see docs/UX-REVIEW.md), loaded by ui/shell.js on every operator page:
   1. "On air" dock: every overlay's on/off state in one row at the bottom, click = show / hide
   2. Draft control: slimmer header, and the On air tab in two columns (live controls first, settings folded)
   3. long help texts folded to one line
   4. Indonesian labels for headings, labels and buttons that were still English */
(function () {
  'use strict';
  const page = location.pathname.replace(/\.html$/, '').replace(/\/+$/, '') || '/';
  const action = (type, b) => fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, ...b }) });

  // ---------- 1. on-air dock ----------
  const ITEMS = [
    { k: 'draft', label: 'Draft', on: (s) => s.visible, toggle: (s) => action('visible', { visible: !s.visible }) },
    { k: 'card', label: 'Stat card', on: (s) => !!(s.statCard && s.statCard.id), detail: (s) => s.statCard && s.statCard.id,
      toggle: (s) => (s.statCard.id ? action('statCard', { id: null }) : (location.href = '/cards')) },
    { k: 'next', label: 'Next match', on: (s) => s.nextMatch.visible, toggle: (s) => action('nextMatch', { visible: !s.nextMatch.visible }) },
    { k: 'ticker', label: 'Running text', on: (s) => s.ticker.visible, toggle: (s) => action('ticker', { visible: !s.ticker.visible }) },
    { k: 'count', label: 'Countdown', on: (s) => s.countdown.visible, toggle: (s) => action('countdown', { visible: !s.countdown.visible }) },
    { k: 'banner', label: 'Banner', on: (s) => s.banner.visible, toggle: (s) => action('banner', { visible: !s.banner.visible }) },
    { k: 'caster', label: 'Caster', on: (s) => s.caster.visible, toggle: (s) => action('caster', { visible: !s.caster.visible }) },
    { k: 'chat', label: 'Karakter chat', on: (s) => s.chat.visible, toggle: (s) => action('chat', { visible: !s.chat.visible }) },
  ];
  let state = null, failed = false;
  const dock = document.createElement('div');
  dock.id = 'uxdock';
  dock.innerHTML = '<span class="ux-title">On air</span>' +
    ITEMS.map((i) => `<button type="button" data-k="${i.k}" title="Klik untuk tampil / sembunyi"><i></i><span>${i.label}</span><em></em></button>`).join('') +
    '<span class="ux-sep"></span><span class="ux-stat" id="uxGsi"></span><span class="ux-stat" id="uxConn"></span>';
  dock.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-k]'); if (!b || !state) return;
    const item = ITEMS.find((i) => i.k === b.dataset.k);
    b.disabled = true;
    try { await item.toggle(state); } finally { b.disabled = false; poll(); }
  });
  function renderDock() {
    for (const i of ITEMS) {
      const b = dock.querySelector(`[data-k="${i.k}"]`), on = !!(state && i.on(state));
      b.classList.toggle('on', on);
      b.querySelector('em').textContent = (on && i.detail && i.detail(state)) || '';
    }
    const gsiAge = state && state.gsi && state.gsi.lastAt ? (state.serverNow || Date.now()) - state.gsi.lastAt : Infinity;
    dock.querySelector('#uxGsi').innerHTML = `<i class="${gsiAge < 5000 ? 'ok' : ''}"></i>${gsiAge < 5000 ? 'GSI masuk' : 'GSI belum ada'}`;
    dock.querySelector('#uxConn').innerHTML = failed ? '<i class="bad"></i>Server terputus' : '<i class="ok"></i>Tersambung';
  }
  async function poll() {
    try { state = await (await fetch('/api/state', { cache: 'no-store' })).json(); failed = false; } catch { failed = true; }
    renderDock();
  }

  // ---------- 2. Draft control ----------
  const AIR_LIVE = ['Stats cards (full screen)', 'Next match overlay (countdown)', 'Running text (ticker)', 'Countdown live', 'Banner teks berputar', 'Caster'];
  const AIR_SETTINGS = ['Hero stats popup & GSI automation', 'In-game player card', 'Karakter live chat (YouTube)', 'Sound effects'];
  function draftControl() {
    for (const id of ['visBtn', 'copyUrl', 'connPill', 'gsiPill']) { const el = document.getElementById(id); if (el) el.hidden = true; }   // now in the dock / sidebar
    document.querySelectorAll('header .hdr-link').forEach((a) => a.remove());
    const seg = document.getElementById('modeSeg');
    if (seg && !document.getElementById('uxModeLabel')) seg.insertAdjacentHTML('beforebegin', '<span id="uxModeLabel" class="ux-label">Sumber draft</span>');
    // On air: live controls first in two columns, rarely changed settings folded below a divider
    const panes = [...document.querySelectorAll('main > [data-pane~="air"]')];
    const title = (p) => (p.querySelector('h2') || {}).textContent || '';
    for (const p of panes) {
      const t = title(p).trim();
      const live = AIR_LIVE.indexOf(t), set = AIR_SETTINGS.indexOf(t);
      p.classList.add('ux-air');
      if (live >= 0) p.style.order = String(live);
      if (set >= 0) {
        p.style.order = String(100 + set);
        p.classList.add('ux-acc');
        p.querySelector('h2').addEventListener('click', () => p.classList.toggle('open'));
      }
    }
    if (panes.length && !document.getElementById('uxAirDiv')) {
      const div = document.createElement('div');
      div.id = 'uxAirDiv'; div.dataset.pane = 'air'; div.style.order = '99';
      div.innerHTML = '<b>Pengaturan</b><span>jarang diubah saat live · klik judul untuk membuka</span>';
      panes[0].parentElement.appendChild(div);
    }
  }

  // ---------- 3. long help texts ----------
  function foldHelp(root) {
    root.querySelectorAll('.hint, .card > p, fieldset > p').forEach((p) => {
      if (p.dataset.ux || p.closest('#uxdock') || p.textContent.trim().length < 140) return;
      p.dataset.ux = '1';
      p.classList.add('ux-fold');
      p.title = 'Klik untuk membaca semuanya';
      p.addEventListener('click', (e) => { if (e.target.closest('a, button, input, select, code')) return; p.classList.toggle('open'); });
    });
  }

  // ---------- 4. Indonesian labels ----------
  const ID = {
    'Setup': 'Persiapan', 'Check': 'Cek', 'Auto (GSI)': 'Otomatis (GSI)', 'Heroes': 'Hero', 'Match setup': 'Persiapan match',
    'Load teams': 'Muat tim', 'Left team': 'Tim kiri', 'Right team': 'Tim kanan', 'Clock & GSI': 'Jam & GSI',
    'Hero image cache': 'Cache gambar hero', 'Portrait framing': 'Framing portrait', 'GSI check — what Dota is sending': 'Cek GSI: data dari Dota',
    'Hero stats popup & GSI automation': 'Popup statistik hero & otomatisasi GSI', 'Next match overlay (countdown)': 'Next match',
    'Running text (ticker)': 'Running text', 'Sound effects': 'Efek suara', 'Stats cards (full screen)': 'Stat cards',
    'In-game player card': 'Kartu pemain in-game', 'Karakter live chat (YouTube)': 'Karakter live chat (YouTube)',
    'Start': 'Mulai', 'Resume': 'Lanjut', 'Undo': 'Urungkan', 'Swap sides': 'Tukar sisi',
    'Teams database': 'Database tim', 'Add team': 'Tambah tim', 'Saved teams': 'Tim tersimpan', 'Players': 'Pemain', 'Captain': 'Kapten',
    'Tournament stats': 'Statistik turnamen', 'Tournament': 'Turnamen', 'Overview': 'Ringkasan', 'Matches': 'Match', 'Heroes ': 'Hero',
    'Add match': 'Tambah match', 'Delete': 'Hapus', '+ New tournament': '+ Turnamen baru', 'Update from OpenDota': 'Update dari OpenDota',
    'Export Excel': 'Ekspor Excel', 'Link selected': 'Tautkan yang dipilih', 'Save': 'Simpan',
    'On air in OBS': 'Tayang di OBS', 'Nothing on screen': 'Tidak ada di layar', 'Prev': 'Sebelumnya', 'Next': 'Berikutnya',
    'Hide': 'Sembunyikan', 'Reload cards': 'Muat ulang kartu', 'Save bracket': 'Simpan bracket', 'Unsaved changes': 'Belum disimpan',
    'Show test popup': 'Tes popup', 'Link players — stats accounts → your rosters': 'Tautkan pemain: akun statistik → roster', 'Draw': 'Undian', 'Bracket & rundown': 'Bracket & rundown', 'Copy OBS URL': 'Copy URL OBS', 'Logout': 'Keluar', 'Preview': 'Pratinjau', 'Show': 'Tampilkan',
  };
  const CONFIRM = { 'Clear all picks, bans and player assignments?': 'Hapus semua pick, ban dan pemain di draft ini?' };
  const nativeConfirm = window.confirm.bind(window);
  window.confirm = (m) => nativeConfirm(CONFIRM[m] || m);
  function translate(root) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const p = n.parentElement;
      if (!p || !p.closest('h1, h2, h3, legend, button, label, th, .pill, .tabs, .seg') || p.closest('#uxdock, select, option')) continue;
      const t = n.nodeValue.trim(), id = ID[t] || (t.startsWith('Tournament stats') ? t.replace('Tournament stats', 'Statistik turnamen') : '');
      if (id) n.nodeValue = n.nodeValue.replace(t, id);
    }
  }

  // ---------- start ----------
  function start() {
    document.body.appendChild(dock);
    document.body.classList.add('ux-has-dock');
    if (page === '/control') draftControl();
    foldHelp(document.body); translate(document.body);
    // pages re-render parts of themselves (lists, buttons): keep folding / translating what they add
    let t = null;
    new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => { foldHelp(document.body); translate(document.body); }, 120); })
      .observe(document.body, { childList: true, subtree: true });
    poll(); setInterval(poll, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
