/* Operator panel shell: left sidebar with the tournament picker and every panel, on all operator pages.
   Load with <script src="/ui/shell.js" defer></script> (after /theme.js). */
(function () {
  // lucide line icons (ISC), one size and stroke
  var IC = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
    video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    chart: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    shuffle: '<path d="m18 14 4 4-4 4"/><path d="m18 2 4 4-4 4"/><path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-7.6a4 4 0 0 1 3.3-1.7H22"/><path d="M2 6h1.972a4 4 0 0 1 3.6 2.2"/><path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  };
  var svg = function (k) { return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + IC[k] + '</svg>'; };
  var NAV = [
    { group: 'Siaran', items: [
      { href: '/control', label: 'Draft control', icon: 'grid' },
      // 2.0: player/team cams are native now (Direborn Cam app -> bridge dashboard); v1's browser cams are retired
      { href: 'http://localhost:8787/', label: 'Kamera', icon: 'video' },
    ] },
    { group: 'Turnamen', items: [
      { href: '/control#air', label: 'On air', icon: 'eye' },
      { href: '/teams', label: 'Teams', icon: 'users' },
      { href: '/stats', label: 'Statistik', icon: 'chart' },
      { href: '/bracket', label: 'Bracket', icon: 'trophy' },
      { href: '/cards', label: 'Stats cards', icon: 'layers' },
    ] },
    { group: 'Lainnya', items: [
      { href: '/mix', label: 'Mix draw', icon: 'shuffle' },
    ] },
  ];
  var OBS = [
    ['Draft overlay', '/overlay'], ['In-game foto', '/ingame'], ['Stats cards', '/statcards'],
    ['Next match', '/nextmatch'], ['Next match 16:9', '/nextmatch-wide'], ['Running text', '/ticker'], ['Mix draw', '/mixdraw'], ['Countdown live', '/countdown'], ['Banner berputar', '/banner'], ['Caster', '/caster'], ['Karakter chat', '/chatwalk'],
  ];
  var THEME_LABEL = { battlecup: 'Direbattle Cup', uprising: 'Direbattle Uprising', direborn: 'Direborn' };
  var here = location.pathname.replace(/\.html$/, '').replace(/\/+$/, '') || '/';
  var navHrefs = {}; NAV.forEach(function (g) { g.items.forEach(function (i) { navHrefs[i.href] = 1; }); });
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  var css = document.createElement('style');
  css.textContent = [
    'body.db-panel{padding-left:248px}',
    '#dbside{position:fixed;left:0;top:0;bottom:0;width:248px;z-index:50;display:flex;flex-direction:column;gap:24px;padding:16px 12px;overflow-y:auto;',
    ' background:var(--bg);border-right:1px solid var(--line);font-family:var(--font);color:var(--text)}',
    '#dbside .sb-brand{display:flex;align-items:center;gap:10px;padding:4px 8px;font:600 15px var(--font);letter-spacing:-.01em;color:var(--text)}',
    '#dbside .sb-brand i{width:8px;height:8px;border-radius:50%;background:var(--tour)}',
    '#dbside .sb-t{display:grid;gap:8px;padding:12px;border-radius:12px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.05)}',
    '#dbside .sb-t label{font:500 12px var(--font);color:var(--muted)}',
    '#dbside select{width:100%;background:#fff;color:var(--text);border:1px solid var(--line-hi);border-radius:8px;padding:8px;font:500 14px var(--font)}',
    '#dbside select option{background:var(--panel)}',
    '#dbside .sb-theme{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted)}',
    '#dbside .sb-theme select{width:auto;padding:4px 8px;font-size:12px}',
    '#dbside nav{display:grid;gap:24px}',
    '#dbside .sb-g{display:grid;gap:2px}',
    '#dbside .sb-g h4{margin:0 0 8px 10px;font:500 12px var(--font);color:var(--muted)}',
    '#dbside a.sb-i,#dbside button.sb-i{position:relative;display:flex;align-items:center;gap:10px;height:34px;padding:0 10px;border-radius:8px;color:var(--text);text-decoration:none;font:500 14px var(--font);border:0;background:none;cursor:pointer;width:100%;text-align:left;transition:background-color .15s}',
    '#dbside .sb-i span.ic{display:flex;width:16px;color:var(--muted)}',
    '#dbside .sb-i:hover{background:rgba(0,0,0,.04)}',
    '#dbside .sb-i.on{background:rgba(0,0,0,.07);font-weight:600}',
    '#dbside .sb-i.on::before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:2px;border-radius:2px;background:var(--tour)}',
    '#dbside .sb-i.on span.ic{color:var(--text)}',
    '#dbside .sb-obs{display:none;gap:2px;padding-left:26px}',
    '#dbside .sb-obs.open{display:grid}',
    '#dbside .sb-obs button{display:flex;justify-content:space-between;gap:8px;height:32px;align-items:center;padding:0 10px;border-radius:8px;background:none;border:0;color:var(--text);font:400 13px var(--font);cursor:pointer;text-align:left}',
    '#dbside .sb-obs button:hover{background:rgba(0,0,0,.04)}',
    '#dbside .sb-obs button em{font:400 12px ui-monospace,Consolas,monospace;font-style:normal;color:var(--muted)}',
    '#dbside .sb-foot{margin-top:auto;display:grid;gap:2px;border-top:1px solid var(--line);padding-top:12px}',
    '#dbside-toggle{display:none;position:fixed;left:12px;top:12px;z-index:60;width:40px;height:40px;align-items:center;justify-content:center;border-radius:8px;border:1px solid var(--line-hi);background:var(--panel2);color:var(--text);cursor:pointer}',
    '#dbside-toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:70;padding:8px 16px;border-radius:8px;background:rgba(29,29,31,.92);border:0;color:#fff;border-radius:12px;font:500 13px var(--font);opacity:0;transition:opacity .2s;pointer-events:none}',
    '#dbside-toast.show{opacity:1}',
    '@media (max-width:900px){body.db-panel{padding-left:0}body.db-panel>header{padding-left:64px!important}#dbside{padding-top:64px;transform:translateX(-100%);transition:transform .2s;box-shadow:0 0 40px rgba(0,0,0,.15)}#dbside.open{transform:none}#dbside-toggle{display:flex}}',
  ].join('\n');
  document.head.appendChild(css);
  // phase 4 operator UX: on-air dock, Draft control layout, folded help, Indonesian labels (?barebone=0 keeps v1 as it was)
  if (!/[?&]barebone=0\b/.test(location.search)) { var ux = document.createElement('script'); ux.src = '/ui/ux.js'; document.head.appendChild(ux); }

  function toast(m) { var t = document.getElementById('dbside-toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(function () { t.classList.remove('show'); }, 2000); }
  function post(url, body) { return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }); }

  function build() {
    document.body.classList.add('db-panel');
    // the old link buttons in each page header are now in the sidebar
    document.querySelectorAll('header a').forEach(function (a) {
      var h = (a.getAttribute('href') || '').replace(/\/+$/, '');
      if (navHrefs[h] || h === '/logout' || h === '/stats' || h === '/cards' || h === '/camcontrol' || h === '/lihat') a.remove();   // v1 browser cams are retired
    });
    var side = document.createElement('aside'); side.id = 'dbside';
    side.innerHTML =
      '<div class="sb-brand"><i></i><span>Direborn broadcast</span></div>' +
      '<div class="sb-t"><label for="sbTour">Turnamen</label><select id="sbTour"><option>…</option></select>' +
      '<div class="sb-theme"><span>Desain</span><select id="sbTheme">' + Object.keys(THEME_LABEL).map(function (k) { return '<option value="' + k + '">' + THEME_LABEL[k] + '</option>'; }).join('') + '</select></div></div>' +
      '<nav>' + NAV.map(function (g) {
        return '<div class="sb-g"><h4>' + esc(g.group) + '</h4>' + g.items.map(function (i) {
          return '<a class="sb-i' + (i.href === here ? ' on' : '') + '" href="' + i.href + '"><span class="ic">' + svg(i.icon) + '</span>' + esc(i.label) + '</a>';
        }).join('') + '</div>';
      }).join('') +
      '<div class="sb-g"><h4>OBS</h4><button class="sb-i" id="sbObsBtn" type="button"><span class="ic">' + svg('copy') + '</span>Copy URL source OBS</button><div class="sb-obs" id="sbObs">' +
      OBS.map(function (o) { return '<button type="button" data-u="' + o[1] + '">' + esc(o[0]) + '<em>' + o[1] + '</em></button>'; }).join('') +
      '</div></div></nav>' +
      '<div class="sb-foot"><a class="sb-i" href="/logout"><span class="ic">' + svg('logout') + '</span>Logout</a></div>';
    document.body.appendChild(side);
    var tg = document.createElement('button'); tg.id = 'dbside-toggle'; tg.type = 'button'; tg.innerHTML = svg('menu'); tg.setAttribute('aria-label', 'Menu');
    tg.onclick = function () { side.classList.toggle('open'); };
    document.body.appendChild(tg);
    var t = document.createElement('div'); t.id = 'dbside-toast'; document.body.appendChild(t);

    side.querySelector('#sbObsBtn').onclick = function () { side.querySelector('#sbObs').classList.toggle('open'); };
    side.querySelector('#sbObs').onclick = function (e) {
      var b = e.target.closest('button[data-u]'); if (!b) return;
      var u = location.origin + b.dataset.u;
      (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(function () { toast('Di-copy: ' + b.dataset.u); }, function () { prompt('Copy:', u); });
    };

    var tourSel = side.querySelector('#sbTour'), themeSel = side.querySelector('#sbTheme'), list = [], active = null;
    function render() {
      tourSel.innerHTML = list.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === active ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') +
        '<option value="__new">+ Turnamen baru…</option>';
      var a = list.filter(function (x) { return x.id === active; })[0];
      if (a) { themeSel.value = a.theme || 'battlecup'; if (window.DBTheme) DBTheme.set(a.theme); }
    }
    function load() { return fetch('/api/tournaments', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) { list = d.list || []; active = d.active; render(); }).catch(function () {}); }
    tourSel.onchange = function () {
      var v = tourSel.value;
      if (v === '__new') {
        var name = prompt('Nama turnamen baru:'); if (!name) { render(); return; }
        post('/api/tournaments/create', { name: name, theme: themeSel.value }).then(function (r) { if (!r.ok) { alert(r.error || 'Gagal'); render(); } else location.reload(); });
        return;
      }
      post('/api/tournaments/switch', { id: v }).then(function (r) { if (!r.ok) { alert(r.error || 'Gagal'); render(); } else location.reload(); });
    };
    themeSel.onchange = function () {
      post('/api/tournaments/theme', { id: active, theme: themeSel.value }).then(function (r) {
        if (!r.ok) { alert(r.error || 'Gagal'); return; }
        list.forEach(function (x) { if (x.id === active) x.theme = themeSel.value; });
        if (window.DBTheme) DBTheme.set(themeSel.value);
        toast('Desain ' + THEME_LABEL[themeSel.value] + ' dipakai');
      });
    };
    // switched from another device: follow it
    if (window.DBTheme) DBTheme.onChange(function (info) {
      if (active && info.id !== active) { toast('Turnamen diganti ke ' + info.name); load(); }
    });
    load();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
