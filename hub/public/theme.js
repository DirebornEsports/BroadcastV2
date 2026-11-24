/* Tournament design (theme) for every page.
   The active tournament decides it: <html data-theme="battlecup|uprising|direborn"> plus /themes/<theme>.css.
   OBS sources follow live (read from the /events stream); ?theme=<name> in the URL forces one (preview). */
(function () {
  var KEY = 'dbTheme', cur = null, forced = null, listeners = [];
  function set(t, info) {
    t = forced || t || 'battlecup';
    if (t !== cur) {
      cur = t;
      document.documentElement.setAttribute('data-theme', t);
      try { localStorage.setItem(KEY, t); } catch (e) {}
      var l = document.getElementById('db-theme-css');
      if (!l) { l = document.createElement('link'); l.id = 'db-theme-css'; l.rel = 'stylesheet'; (document.head || document.documentElement).appendChild(l); }
      // Broadcast 2.0 phases 0-3: no tournament design (barebone, see ui/barebone.css); ?barebone=0 restores it
      if (/[?&]barebone=0\b/.test(location.search)) l.href = '/themes/' + t + '.css';
    }
    if (info) listeners.forEach(function (f) { try { f(info); } catch (e) {} });
  }
  // panel colour channels used as rgba(var(--x-rgb), a); the themes override them
  // which page this is (themes style each overlay on its own): /nextmatch-wide -> data-page="nextmatch-wide"
  document.documentElement.setAttribute('data-page', (location.pathname.replace(/\.html$/, '').replace(/^\/+|\/+$/g, '') || 'home'));
  var base = document.createElement('style');
  base.textContent = ':root{--shade-rgb:5,16,10;--bg-rgb:10,26,18;--panel-rgb:16,41,28;--panel2-rgb:23,61,41;--line-rgb:214,189,134;--hi-rgb:243,228,184;--bg:#0a1a12;--panel:#10291c;--panel2:#173d29;--panel3:#1f5236}';
  (document.head || document.documentElement).appendChild(base);
  try { forced = new URLSearchParams(location.search).get('theme'); } catch (e) {}
  var saved = null; try { saved = localStorage.getItem(KEY); } catch (e) {}
  set(saved);
  // follow the live state stream that every overlay already opens
  var ES = window.EventSource;
  if (ES) {
    var re = /"tournamentInfo":\{"id":"([^"]*)","name":"((?:[^"\\]|\\.)*)","theme":"([a-z]+)"\}/;
    var Wrapped = function (url, opts) {
      var es = new ES(url, opts);
      if (String(url).indexOf('/events') !== -1) es.addEventListener('message', function (e) {
        var m = re.exec(e.data); if (m) set(m[3], { id: m[1], name: JSON.parse('"' + m[2] + '"'), theme: m[3] });
      });
      return es;
    };
    Wrapped.prototype = ES.prototype; Wrapped.CONNECTING = 0; Wrapped.OPEN = 1; Wrapped.CLOSED = 2;
    window.EventSource = Wrapped;
  }
  window.DBTheme = { set: set, get: function () { return cur; }, onChange: function (f) { listeners.push(f); } };
})();
