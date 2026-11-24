/* Motion engine: every CSS animation and transition on the page is played by anime.js (its Web Animations mode,
   anime.waapi) instead of the browser's CSS engine. The CSS stays the single source of the design: when one starts,
   this reads its exact keyframes and timing, starts it with anime.waapi.animate() and gives anime's animations those
   same keyframe positions, per-step easings, delay, loops and fill, so nothing looks different. The CSS one stays as a
   placeholder with no keyframes, so removing a class still stops it like before.
   Load after /vendor/anime.umd.min.js, in <head>. Off for one OBS source: add ?anime=0 to its URL. */
(function () {
  'use strict';
  // Broadcast 2.0, phases 0-3: barebone look and no animation on every page (phase 4 brings the design back).
  // Off for one page: ?barebone=0
  if (!/[?&]barebone=0\b/.test(location.search)) {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = '/ui/barebone.css';
    (document.head || document.documentElement).appendChild(l);
    return;
  }
  const A = window.anime;
  if (!A || !A.waapi || !A.waapi.animate || /[?&]anime=0\b/.test(location.search) || !Element.prototype.getAnimations) return;
  const stats = window.__motion = { anime: 0, css: 0, why: {} };
  const keep = (why) => { stats.css++; stats.why[why] = (stats.why[why] || 0) + 1; };
  const META = ['offset', 'computedOffset', 'easing', 'composite'];

  function resolveVars(el, v) {                              // Web Animations keyframes cannot hold var(): use the element's values
    let s = String(v), guard = 0;
    while (/var\(/.test(s) && guard++ < 8) s = s.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_, n, fb) => getComputedStyle(el).getPropertyValue(n).trim() || (fb || '').trim());
    return /var\(/.test(s) ? null : s;
  }

  function takeOver(el, css) {
    if (css.__motion) return;
    css.__motion = true;                                     // never take the same one twice (and never our own)
    const fx = css.effect;
    if (!fx || !fx.getKeyframes || fx.pseudoElement) return keep('pseudo');
    const t = fx.getTiming(), kfs = fx.getKeyframes();
    if (!Number(t.duration) || !kfs.length) return keep('empty');
    const props = [...new Set(kfs.flatMap((k) => Object.keys(k).filter((p) => !META.includes(p))))];
    // exact keyframes for each property: its own positions and easings, var() resolved
    const perProp = {};
    for (const p of props) {
      const list = [];
      for (const k of kfs) if (k[p] !== undefined) {
        const v = resolveVars(el, k[p]); if (v === null) return keep('var');
        list.push({ offset: k.computedOffset ?? k.offset, easing: k.easing || 'linear', [p]: v });
      }
      perProp[p] = list;
    }
    let anim;
    try {
      // persist: anime keeps its animation instead of writing the end values inline (inline would beat class rules,
      // e.g. a hidden overlay could no longer hide)
      const params = { duration: t.duration, delay: t.delay || 0, ease: 'linear', autoplay: true, persist: true };
      for (const p of props) params[p] = perProp[p].map((k) => k[p]);
      anim = A.waapi.animate(el, params);
      const natives = (anim.animations || []).filter((n) => n && n.effect);
      if (natives.length !== props.length) throw new Error('animation count');
      natives.forEach((n, i) => {                            // anime makes one per property, in the order given
        const p = props[i];
        // anime commits an animation's values inline when a newer one on the same property replaces or cancels it
        // (hide -> show); CSS leaves nothing behind, so neither do we
        n.commitStyles = () => {};
        n.effect.setKeyframes(perProp[p]);
        n.effect.updateTiming({ duration: t.duration, delay: t.delay, endDelay: t.endDelay, iterations: t.iterations, iterationStart: t.iterationStart,
          direction: t.direction, fill: t.fill, easing: t.easing });
        n.currentTime = css.currentTime || 0;                // in step with where the CSS one already is
      });
    } catch (e) { try { anim && anim.cancel && anim.cancel(); } catch {} return keep('anime-error'); }
    fx.setKeyframes([]);                                     // the CSS one stays as a placeholder with no visible effect
    stats.anime++;
    const stop = () => { try { (anim.animations || []).forEach((n) => n.cancel()); } catch {} };
    css.addEventListener('cancel', stop, { once: true });   // class removed / transition interrupted: undo, like CSS
    // finished: a transition ends on its new base value, an animation without forwards fill leaves no trace
    const transition = window.CSSTransition && css instanceof CSSTransition;
    if (transition || !['forwards', 'both'].includes(t.fill)) css.addEventListener('finish', stop, { once: true });
  }
  function scan(el) {
    for (const a of el.getAnimations()) {
      const isCss = (window.CSSAnimation && a instanceof CSSAnimation) || (window.CSSTransition && a instanceof CSSTransition);
      if (isCss && a.effect && a.effect.target === el && !a.effect.pseudoElement) takeOver(el, a);
    }
  }
  document.addEventListener('animationstart', (e) => { if (!e.pseudoElement) scan(e.target); }, true);
  document.addEventListener('transitionrun', (e) => { if (!e.pseudoElement) scan(e.target); }, true);
})();
