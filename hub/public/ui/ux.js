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
    renderDock(); renderTurn();
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
    draftTab(); mergeTabs(); teamPickers(); netMode();
  }

  // Draft + Persiapan are one page (draft first, setup below); On air opens from the sidebar (/control#air)
  function mergeTabs() {
    const tabs = document.getElementById('tabs'); if (!tabs) return;
    const btn = (t) => tabs.querySelector(`[data-tab="${t}"]`);
    btn('setup').hidden = btn('air').hidden = true;
    const go = () => {
      const now = document.body.dataset.tab;
      const want = location.hash === '#air' ? 'air' : now === 'check' ? 'check' : 'draft';
      if (now !== want) btn(want).click();
      syncNav();
    };
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (b && !b.hidden && location.hash) history.replaceState(null, '', location.pathname + location.search);
      syncNav();
    });
    window.addEventListener('hashchange', go);
    go();
    // the Hero list folds away (remembered per device)
    const grid = document.getElementById('grid'), card = grid && grid.closest('section.card');
    if (card) {
      fold(card, localStorage.getItem('dbo.heroOpen') !== '0');
      card.querySelector(':scope > h2').addEventListener('click', () => localStorage.setItem('dbo.heroOpen', card.classList.contains('open') ? '1' : '0'));
    }
  }
  function syncNav() {
    const air = document.body.dataset.tab === 'air';
    document.querySelectorAll('#dbside a.sb-i').forEach((a) => {
      const h = a.getAttribute('href');
      if (h === '/control') a.classList.toggle('on', !air);
      if (h === '/control#air') a.classList.toggle('on', air);
    });
  }

  // the team names on the board: filled from Persiapan, click to swap in another saved team
  function teamPickers() {
    for (const side of ['left', 'right']) {
      const nm = document.getElementById('nm-' + side), src = document.getElementById(side === 'left' ? 'dbLeft' : 'dbRight');
      if (!nm || !src || nm.parentElement.classList.contains('ux-teampick')) continue;
      const wrap = document.createElement('span'); wrap.className = 'ux-teampick'; wrap.title = 'Klik untuk ganti tim';
      nm.before(wrap); wrap.appendChild(nm);
      const sel = document.createElement('select'); sel.setAttribute('aria-label', 'Ganti tim ' + (side === 'left' ? 'kiri' : 'kanan'));
      wrap.appendChild(sel);
      const sync = () => { sel.innerHTML = src.innerHTML; sel.value = src.value; };
      sel.addEventListener('mousedown', sync);
      sel.addEventListener('focus', () => { src.dispatchEvent(new Event('focus')); sync(); });   // the page reloads the team list on focus
      sel.addEventListener('change', () => { if (!sel.value) return; src.value = sel.value; src.dispatchEvent(new Event('change')); sel.blur(); });
    }
  }

  // LAN / Online for the player cams: the camera bridge (port 8787 on this PC) owns the setting; the relay address
  // and key are set on the Kamera page, so "Online" without them opens it
  function netMode() {
    const head = document.querySelector('body > header'); if (!head || document.getElementById('uxNet')) return;
    const BR = 'http://localhost:8787';
    head.insertAdjacentHTML('beforeend', '<span class="ux-net"><span class="ux-label">Kamera</span><span class="seg" id="uxNet" title="LAN = pemain satu jaringan · Online = pemain dari rumah lewat Cloudflare">' +
      '<button type="button" data-net="lan">LAN</button><button type="button" data-net="online">Online</button></span></span>');
    const seg = document.getElementById('uxNet');
    const paint = (o) => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', !!o && (b.dataset.net === 'online') === o.on));
    const load = () => fetch(BR + '/studio/online').then((r) => r.json()).then(paint).catch(() => paint(null));
    seg.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const o = await fetch(BR + '/studio/online', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: b.dataset.net === 'online' }) })
        .then((r) => r.json()).catch(() => null);
      paint(o);
      if (b.dataset.net === 'online' && o && !o.on) location.href = BR + '/';   // no relay address / key yet: set them on the Kamera page
    });
    load(); setInterval(load, 5000);
  }

  // Draft tab: whose turn it is, big; the hero grid fits the screen; shortcuts visible
  function draftTab() {
    const board = document.querySelector('.board'), next = document.getElementById('next');
    if (!board || !next || document.getElementById('uxTurn')) return;
    const turn = document.createElement('div');
    turn.id = 'uxTurn';
    turn.innerHTML = '<i></i><div><span class="ux-turn-k">Giliran</span><b id="uxTurnWho">-</b></div><em id="uxTurnWhat">-</em>';
    board.parentElement.insertBefore(turn, board);
    new MutationObserver(() => poll()).observe(next, { childList: true, characterData: true, subtree: true });   // the page knows first: refresh the banner right away
    const search = document.getElementById('search');
    if (search) {
      search.placeholder = 'Cari hero… (Enter = pilih yang paling atas)';
      search.closest('.filters').insertAdjacentHTML('afterend',
        '<div id="uxKeys"><span><kbd>Enter</kbd> pilih</span><span><kbd>Esc</kbd> kosongkan cari</span><span><kbd>Ctrl</kbd>+<kbd>Z</kbd> urungkan</span>' +
        '<span>klik slot = targetkan</span><span>klik kanan slot = hapus</span></div>');
    }
    // the search row stays under the header while scrolling the heroes, with a small copy of the turn
    const filters = search && search.closest('.filters');
    if (filters) filters.insertAdjacentHTML('beforeend', '<span id="uxTurnMini"></span>');
  }
  function renderTurn() {
    const el = document.getElementById('uxTurn'); if (!el || !state) return;
    const a = state.active, gsi = state.mode === 'gsi';
    const done = !a || a.side == null;
    const team = !done && state.teams[a.side];
    el.style.setProperty('--team', (team && team.color) || '#161618');
    el.classList.toggle('done', done);
    document.getElementById('uxTurnWho').textContent = done ? 'Draft selesai' : (team.name || (a.side === 'left' ? 'Tim kiri' : 'Tim kanan'));
    document.getElementById('uxTurnWhat').textContent = done ? '' : `${a.type === 'ban' ? 'BAN' : 'PICK'} ${a.index + 1}${gsi ? ' · otomatis dari Dota' : ''}`;
    const mini = document.getElementById('uxTurnMini');
    if (mini) { mini.textContent = done ? 'Draft selesai' : `${a.type === 'ban' ? 'BAN' : 'PICK'} ${a.index + 1} · ${team.tag || team.name || ''}`; mini.style.setProperty('--team', (team && team.color) || '#161618'); }
    document.querySelectorAll('.board .tb').forEach((tb) => tb.classList.toggle('ux-turn', !done && tb.classList.contains(a.side)));
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
    'Show test popup': 'Tes popup', 'Switch to Auto (GSI)': 'Pindah ke Otomatis (GSI)', 'Download last GSI data': 'Unduh data GSI terakhir', 'Anti-snipe delay': 'Delay anti-snipe', 'Receiving from Dota': 'Data dari Dota', 'Upload…': 'Upload…', 'Title': 'Judul', 'Format': 'Format', 'First pick': 'First pick', 'Name': 'Nama', 'Score': 'Skor', 'Color': 'Warna', 'Now': 'Sekarang', 'reserve': 'cadangan', 'All': 'Semua',
    'auto-restart clock each step': 'jam mulai ulang tiap langkah', 'Swap sides ': 'Tukar sisi', 'Link players — stats accounts → your rosters': 'Tautkan pemain: akun statistik → roster', 'Draw': 'Undian', 'Bracket & rundown': 'Bracket & rundown', 'Copy OBS URL': 'Copy URL OBS', 'Logout': 'Keluar', 'Preview': 'Pratinjau', 'Show': 'Tampilkan',
  };
  const CONFIRM = { 'Clear all picks, bans and player assignments?': 'Hapus semua pick, ban dan pemain di draft ini?' };
  const nativeConfirm = window.confirm.bind(window);
  window.confirm = (m) => nativeConfirm(CONFIRM[m] || m);
  function translate(root) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const p = n.parentElement;
      if (!p || !p.closest('h1, h2, h3, legend, button, label, th, .pill, .tabs, .seg, .next, .reserves') || p.closest('#uxdock, select, option')) continue;
      const t = n.nodeValue.trim(), id = ID[t] || (t.startsWith('Tournament stats') ? t.replace('Tournament stats', 'Statistik turnamen') : '');
      if (id && id !== t) n.nodeValue = n.nodeValue.replace(t, id);   // same text: writing it again would re-trigger the observer forever
    }
  }

  // ---------- 5. preparation pages ----------
  // a card that is rarely needed: only its title shows until clicked (same look as the On air settings)
  function fold(card, open) {
    const h = card && card.querySelector(':scope > h2'); if (!h || card.classList.contains('ux-acc')) return;
    card.classList.add('ux-acc'); if (open) card.classList.add('open');
    h.addEventListener('click', () => card.classList.toggle('open'));
  }
  // long pages: a sticky row of chips that jumps to each section
  function jumpBar(cards) {
    cards = cards.filter((c) => c.querySelector(':scope > h2'));
    if (cards.length < 3 || document.getElementById('uxJump')) return;
    const bar = document.createElement('nav');
    bar.id = 'uxJump';
    cards.forEach((c, i) => {
      const b = document.createElement('button'); b.type = 'button';
      b.textContent = c.querySelector(':scope > h2').textContent.replace(/—.*$/, '').trim();
      b.onclick = () => { c.classList.add('open'); window.scrollTo({ top: c.getBoundingClientRect().top + window.scrollY - 130 }); };
      bar.appendChild(b);
    });
    const main = document.querySelector('main');
    main.parentElement.insertBefore(bar, main);
  }
  function prepPages() {
    const cards = [...document.querySelectorAll('main section.card')];
    const byTitle = (t) => cards.find((c) => ((c.querySelector(':scope > h2') || {}).textContent || '').trim().startsWith(t));
    if (page === '/control') {
      // Persiapan tab: team forms side by side; image cache and portrait framing are rarely touched
      const form = document.getElementById('setup'); if (form) form.classList.add('ux-setup');
      // image cache and portrait framing live in the same card after the form: fold each under its title
      document.querySelectorAll('[data-pane~="setup"] > h2').forEach((h) => {
        if (!/^(Hero image cache|Portrait framing)/.test(h.textContent.trim()) || h.dataset.ux) return;
        h.dataset.ux = '1';
        const box = document.createElement('div'); box.className = 'ux-sub';
        while (h.nextElementSibling && !/^(H2|HR)$/.test(h.nextElementSibling.tagName)) box.appendChild(h.nextElementSibling);
        h.after(box); h.classList.add('ux-subh');
        h.addEventListener('click', () => h.classList.toggle('open'));
      });
    }
    if (page === '/teams') { fold(byTitle('Impor tim dari tiket liga')); }
    if (page === '/bracket') { fold(document.getElementById('setCard')); jumpBar(cards.filter((c) => c.id !== 'emptyCard')); }
    if (page === '/stats') jumpBar(cards);
  }

  // ---------- start ----------
  function start() {
    document.body.appendChild(dock);
    document.body.classList.add('ux-has-dock');
    if (page === '/control') draftControl();
    prepPages();
    foldHelp(document.body); translate(document.body);
    // pages re-render parts of themselves (lists, buttons): keep folding / translating what they add
    let t = null;
    new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => { foldHelp(document.body); translate(document.body); }, 120); })
      .observe(document.body, { childList: true, subtree: true });
    poll(); setInterval(poll, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
