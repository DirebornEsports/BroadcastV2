/*
 * Animation sound effects shared by the OBS sources (overlay, stat cards, in-game card).
 * Files: public/sounds/sfx/<name>.wav — drop your own <name>.mp3/.ogg in the same folder to replace one.
 * On/off and volume come from the control panel (state.sfx). In OBS tick "Control audio via OBS"
 * on each Browser source so the sounds reach the mixer.
 */
window.SFX = (() => {
  let files = {}, enabled = true, volume = 0.6, lastTest = null, ready = false;
  const base = {};
  const load = () => fetch('/api/sounds', { cache: 'no-store' }).then((r) => r.json()).then((m) => {
    files = (m && m.sfx) || {};
    for (const [k, f] of Object.entries(files)) {
      if (base[k] && base[k]._f === f) continue;
      const a = new Audio('/sounds/' + f); a.preload = 'auto'; a._f = f; base[k] = a;
    }
    ready = true;
  }).catch(() => {});
  load(); setInterval(load, 30000);

  function play(name, delay = 0, gain = 1) {
    if (!enabled || !base[name]) return;
    const go = () => { const a = base[name].cloneNode(); a.volume = Math.max(0, Math.min(1, volume * gain)); a.play().catch(() => {}); };
    delay > 0 ? setTimeout(go, delay) : go();
  }
  // state.sfx from the server: { enabled, volume, test: { name, at } }
  function config(c, ownsTest) {
    if (!c) return;
    enabled = c.enabled !== false;
    volume = Number.isFinite(Number(c.volume)) ? Number(c.volume) : 0.6;
    if (ownsTest && c.test && c.test.at !== lastTest) {
      const fresh = lastTest !== null && Date.now() - c.test.at < 5000;
      lastTest = c.test.at;
      if (fresh) play(c.test.name);
    } else if (lastTest === null) lastTest = c.test ? c.test.at : 0;
  }
  return { play, config, has: (n) => !!base[n], get ready() { return ready; } };
})();
