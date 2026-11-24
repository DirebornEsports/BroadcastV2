// Direborn player cam — browser side (shared by the sender page, the test page and the OBS cam overlay).
// The same file lives in direborn-cam/public/rtc.js and dota-draft-overlay/public/camrtc.js.
(function (root) {
  'use strict';
  const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }];

  async function api(base, path, body) {
    let r;
    try {
      r = await fetch(String(base).replace(/\/+$/, '') + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), cache: 'no-store' });
    } catch (e) { throw new Error('Server cam tidak bisa dihubungi (' + e.message + ')'); }
    let d = null; try { d = await r.json(); } catch {}
    if (!r.ok || !d || d.ok === false) { const err = new Error((d && d.error) || 'HTTP ' + r.status); err.status = r.status; throw err; }
    return d;
  }
  async function getIce(base, key) {
    try { const d = await api(base, '/api/cam/ice', { key }); return d.iceServers && d.iceServers.length ? d.iceServers : STUN; } catch { return STUN; }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function waitIce(pc, ms = 2500) {          // send the offer with the gathered candidates (no trickle)
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(res, ms);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }

  /**
   * Publish one camera track (+ optional mic track) and keep it published (reconnects by itself).
   * opts: { base, key, name, track, audioTrack, maxBitrate, codec() -> 'h264' | 'vp8' (read at each connect; a change reconnects), onState(state, info) }
   * returns { stop(), replaceTrack(track), replaceAudio(track) }
   */
  // a keyframe every 4 s from the sender itself, so the OBS overlay can jump around in its delay buffer
  // (horn sync). Chrome makes a keyframe when the encoder resolution changes: alternate 100% / 99%
  // (invisible, the overlay scales the picture anyway).
  function keyframeTimer(pc, sender) {
    let flip = false;
    const iv = setInterval(async () => {
      try {
        if (pc.signalingState === 'closed') { clearInterval(iv); return; }
        if (!sender.track || pc.connectionState !== 'connected') return;
        const p = sender.getParameters(); if (!p.encodings || !p.encodings.length) return;
        flip = !flip; p.encodings[0].scaleResolutionDownBy = flip ? 1.01 : 1;
        await sender.setParameters(p);
      } catch {}
    }, 4000);          // a seek decodes forward from the keyframe, so 4 s keeps it exact at half the keyframe cost
    return () => clearInterval(iv);
  }

  function publish(opts) {
    let pc = null, stopped = false, sessionId = null, hb = null, track = opts.track, audio = opts.audioTrack || null, attempt = 0;
    const state = (s, info) => { try { opts.onState && opts.onState(s, info || {}); } catch {} };
    async function connect() {
      while (!stopped) {
        try {
          state('connecting', { attempt });
          const ice = await getIce(opts.base, opts.key);
          pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle' });
          const tr = pc.addTransceiver(track, { direction: 'sendonly' });
          keyframeTimer(pc, tr.sender);
          // H.264 is encoded on the graphics card (NVENC / QuickSync) and decoded there in OBS; VP8 runs on the CPU.
          // The other one stays second choice for a browser that lacks the first.
          const codec = opts.codec ? opts.codec() : 'vp8';
          try {
            const caps = RTCRtpSender.getCapabilities('video');
            const of = (re) => caps.codecs.filter((c) => re.test(c.mimeType));
            // constrained baseline (42e01f) + packetization-mode=1 first: the profile the graphics card encoders take
            const fit = (c) => /packetization-mode=1/.test(c.sdpFmtpLine || '') * 2 + /profile-level-id=42e0/i.test(c.sdpFmtpLine || '');
            const h264 = of(/h264/i).sort((a, b) => fit(b) - fit(a));
            const vp8 = of(/vp8/i), rtx = of(/rtx|red|ulpfec/i);
            if (tr.setCodecPreferences) tr.setCodecPreferences([...(codec === 'h264' ? [...h264, ...vp8] : [...vp8, ...h264]), ...rtx]);
          } catch {}
          const p = tr.sender.getParameters(); p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
          p.encodings[0].maxBitrate = opts.maxBitrate || 1500000; p.encodings[0].maxFramerate = 30;
          p.degradationPreference = 'maintain-framerate';
          try { await tr.sender.setParameters(p); } catch {}
          // mic: Opus, mono voice
          let atr = null;
          if (audio) {
            atr = pc.addTransceiver(audio, { direction: 'sendonly' });
            try { const ap = atr.sender.getParameters(); ap.encodings = ap.encodings && ap.encodings.length ? ap.encodings : [{}]; ap.encodings[0].maxBitrate = 64000; await atr.sender.setParameters(ap); } catch {}
          }
          await pc.setLocalDescription(await pc.createOffer());
          await waitIce(pc);
          const s = track.getSettings ? track.getSettings() : {};
          const d = await api(opts.base, '/api/cam/publish', { key: opts.key, name: opts.name, sdp: pc.localDescription.sdp, mid: tr.mid, micMid: atr ? atr.mid : undefined, width: s.width, height: s.height, device: opts.device || '' });
          sessionId = d.sessionId;
          await pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
          const ok = await new Promise((res) => {
            const t = setTimeout(() => res(pc.connectionState === 'connected'), 15000);
            pc.addEventListener('connectionstatechange', () => {
              if (pc.connectionState === 'connected') { clearTimeout(t); res(true); }
              if (pc.connectionState === 'failed') { clearTimeout(t); res(false); }
            });
          });
          if (!ok) {
            let cand = '';
            try { (await pc.getStats()).forEach((r) => { if (r.type === 'candidate-pair' && r.state) cand = cand || r.state; }); } catch {}
            throw new Error(`Server sudah jawab, tapi jalur video ke Cloudflare tidak tembus (ICE ${pc.iceConnectionState}${cand ? ', ' + cand : ''}). Jaringan ini kemungkinan memblokir UDP — coba WiFi/hotspot lain, atau aktifkan TURN.`);
          }
          attempt = 0;
          state('live', { sessionId });
          hb = setInterval(async () => {
            try { const r = await api(opts.base, '/api/cam/heartbeat', { key: opts.key, name: opts.name, sessionId }); if (r.kicked) { stopped = true; clearInterval(hb); try { pc.close(); } catch {} state('kicked', {}); } else if (!r.current) state('replaced', {}); } catch {}
          }, 8000);
          // stay here until the connection drops
          await new Promise((res) => {
            const check = () => { if (stopped || ['failed', 'closed'].includes(pc.connectionState) || (opts.codec && opts.codec() !== codec)) res(); };
            pc.addEventListener('connectionstatechange', () => {
              check();
              if (pc.connectionState === 'disconnected') setTimeout(() => { if (pc.connectionState === 'disconnected') res(); }, 6000);
            });
            const iv = setInterval(() => { if (stopped || (opts.codec && opts.codec() !== codec)) { clearInterval(iv); res(); } }, 500);
          });
        } catch (e) {
          if (e.status === 403 || e.status === 400) { state('error', { message: e.message, fatal: true }); stopped = true; break; }
          state('error', { message: e.message });
        }
        clearInterval(hb);
        try { pc && pc.close(); } catch {}
        if (stopped) break;
        attempt++;
        state('reconnecting', { attempt });
        await sleep(Math.min(10000, 1000 * attempt));
      }
    }
    connect();
    return {
      stop() {
        stopped = true; clearInterval(hb);
        try { pc && pc.close(); } catch {}
        const body = JSON.stringify({ key: opts.key, name: opts.name, sessionId });
        try { navigator.sendBeacon(String(opts.base).replace(/\/+$/, '') + '/api/cam/unpublish', new Blob([body], { type: 'application/json' })); } catch {}
        state('stopped', {});
      },
      async replaceTrack(t) { track = t; const tr = pc && pc.getTransceivers().find((x) => x.sender.track ? x.sender.track.kind === 'video' : x.receiver.track.kind === 'video'); if (tr) await tr.sender.replaceTrack(t); },
      async replaceAudio(t) { if (!audio) return false; audio = t; const tr = pc && pc.getTransceivers().find((x) => x.receiver.track.kind === 'audio'); if (tr) await tr.sender.replaceTrack(t); return true; },
      get hasAudio() { return !!audio; },
      get sessionId() { return sessionId; },
      get pc() { return pc; },
    };
  }

  /**
   * Pull one player's cam (+ mic). opts: { base, key, name, iceServers, onFrame(encodedFrame), onTrack(videoTrack), onAudio(audioTrack), onState(state) }
   * With onFrame the encoded video frames are handed over before decoding (used for the delay buffer).
   */
  async function pull(opts) {
    const pc = new RTCPeerConnection({ iceServers: opts.iceServers || STUN, bundlePolicy: 'max-bundle', encodedInsertableStreams: !!opts.onFrame });
    pc.ontrack = (e) => {
      const video = e.track.kind === 'video';
      if (opts.onFrame) {
        // with insertable streams on, every receiver has to be piped or its media stops
        const { readable, writable } = e.receiver.createEncodedStreams();
        if (video) readable.pipeThrough(new TransformStream({ transform(frame, ctl) { let r; try { r = opts.onFrame(frame); } catch {} if (r !== 'drop') ctl.enqueue(frame); } })).pipeTo(writable).catch(() => {});
        else if (opts.onAudioFrame) readable.pipeThrough(new TransformStream({ transform(frame, ctl) { try { opts.onAudioFrame(frame); } catch {} ctl.enqueue(frame); } })).pipeTo(writable).catch(() => {});
        else readable.pipeTo(writable).catch(() => {});
      }
      if (video) opts.onTrack && opts.onTrack(e.track, e);
      else opts.onAudio && opts.onAudio(e.track, e);
    };
    pc.onconnectionstatechange = () => opts.onState && opts.onState(pc.connectionState);
    try {
      const d = await api(opts.base, '/api/cam/pull', { key: opts.key, name: opts.name });
      await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await waitIce(pc, 1500);
      await api(opts.base, '/api/cam/pull/answer', { key: opts.key, sessionId: d.sessionId, sdp: pc.localDescription.sdp });
      return { pc, sessionId: d.sessionId, since: d.since, mic: !!d.mic, close() { try { pc.close(); } catch {} } };
    } catch (e) { try { pc.close(); } catch {} throw e; }
  }

  /**
   * Plays encoded VP8 / H.264 frames `delay` ms after they arrived, decoded with WebCodecs onto a canvas.
   * Memory stays small (encoded frames only: ~30 MB per cam for 2.5 min at 1.5 Mbps).
   */
  /*
   * DelayCam: keeps the encoded video frames and shows each one `delay` after it arrived.
   * It keeps some history behind the playhead (retainMs), so the delay can be raised without a gap:
   * it jumps back to a keyframe in the history. For that it asks the sender for a keyframe every few
   * seconds (by holding one frame back from the browser's own decoder, which then asks for a keyframe).
   */
  // which codec an encoded frame is: the browser says so; older ones: H.264 frames start with an Annex B start code
  function codecOf(frame) {
    try { const m = frame.getMetadata && frame.getMetadata().mimeType; if (m) return /h264/i.test(m) ? 'h264' : 'vp8'; } catch {}
    const b = new Uint8Array(frame.data, 0, Math.min(4, frame.data.byteLength));
    return b[0] === 0 && b[1] === 0 && (b[2] === 1 || (b[2] === 0 && b[3] === 1)) ? 'h264' : 'vp8';
  }
  // WebCodecs wants the exact H.264 profile + level ("avc1.PPCCLL"): read it from the keyframe's SPS
  function avcCodec(data) {
    const b = new Uint8Array(data), hex = (x) => x.toString(16).padStart(2, '0');
    for (let i = 0; i + 6 < b.length; i++) if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && (b[i + 3] & 31) === 7) return 'avc1.' + hex(b[i + 4]) + hex(b[i + 5]) + hex(b[i + 6]);
    return 'avc1.42e01f';
  }

  class DelayCam {
    constructor(canvas) {
      this.canvas = canvas; this.ctx = canvas.getContext('2d');
      this.frames = []; this.pos = 0; this.gen = 0; this.curGen = -1; this.dec = null; this.needKey = true; this.lastDecT = -Infinity;
      this.firstAt = 0; this.lastAt = 0; this.lastShownAt = 0; this.recv = 0; this.shown = 0; this.w = 0; this.h = 0; this.errors = 0; this.lag = 0;
      this.keyEvery = 5000; this.lastKeyAt = 0; this.lastAskAt = 0; this.keys = 0; this.seeks = 0; this.losses = 0; this.sent = 0; this.err = '';
      this.full = true; this.drawFrom = 0;            // full = decode every frame; off screen only keyframes are decoded
    }
    newSource() { this.gen++; }                        // a new connection: its first frame must be a keyframe
    /* A frame lost on the network: the frames after it still arrive whole but point at a picture we never got, and
       decoding them smears blocks over the image until the next keyframe. We get them before the browser checks
       that, but the browser's own decoder notices and asks the sender for a keyframe (PLI/FIR in getStats). Then the
       frames of the last moments are marked bad (up to the keyframe that answered, if it is here already): playback
       holds the last good picture until a keyframe instead. With the delay buffer this happens long before they show. */
    watch(pc) {
      clearInterval(this.watchT);
      let last = null, polled = performance.now();
      this.watchT = setInterval(async () => {
        const at = performance.now();
        if (pc.connectionState === 'closed') return clearInterval(this.watchT);
        let n = null;
        try { (await pc.getStats()).forEach((x) => { if (x.type === 'inbound-rtp' && x.kind === 'video') n = (x.pliCount || 0) + (x.firCount || 0); }); } catch {}
        if (n === null) return;
        // our own keyframe ask (push() holding a frame back) makes a request too: not a loss
        if (last !== null && n > last && at - this.lastAskAt > 3000) this.lost(polled);
        last = n; polled = at;
      }, 250);
    }
    // asked: the request was not in the previous getStats, so a keyframe after that is the answer; anything older is not
    lost(asked, windowMs = 1500) {
      const fr = this.frames, from = performance.now() - windowMs;
      let end = fr.length;                              // the first keyframe after `asked` (the answer), if it is here yet
      for (let i = fr.length - 1; i >= 0 && fr[i].t > asked; i--) if (fr[i].key) end = i;
      for (let i = end - 1; i >= this.pos && fr[i].t >= from; i--) if (!fr[i].key) fr[i].bad = true;
      this.losses++;
    }
    push(frame) {
      const now = performance.now();
      if (!this.firstAt) this.firstAt = now;
      this.lastAt = now; this.recv++;
      const key = frame.type === 'key';
      this.frames.push({ t: now, key, data: frame.data.slice(0), gen: this.gen, codec: codecOf(frame) });
      if (key) { this.lastKeyAt = now; this.keys++; return; }
      if (now - this.lastKeyAt > this.keyEvery && now - this.lastAskAt > this.keyEvery) { this.lastAskAt = now; return 'drop'; }
    }
    resetDecoder() {
      try { this.dec && this.dec.state !== 'closed' && this.dec.close(); } catch {}
      this.dec = null; this.needKey = true;
    }
    makeDecoder(f) {
      this.dec = new VideoDecoder({
        output: (vf) => {
          try {
            if (vf.timestamp / 1000 < this.drawFrom) return;            // catching up after coming back on screen
            const w = vf.displayWidth, h = vf.displayHeight;
            if (w !== this.w || h !== this.h) { this.canvas.width = this.w = w; this.canvas.height = this.h = h; }
            this.ctx.drawImage(vf, 0, 0, w, h);
            this.shown++; this.lastShownAt = performance.now();
            this.lag = this.lastShownAt - vf.timestamp / 1000;          // how long ago this frame arrived = the real delay
          } finally { vf.close(); }
        },
        error: (e) => { this.errors++; this.err = (this.codec || '') + ': ' + ((e && e.message) || e); this.dec = null; this.needKey = true; },
      });
      this.dec.configure({ codec: f.codec === 'h264' ? avcCodec(f.data) : 'vp8', optimizeForLatency: true });
    }
    keyBefore(t) { for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i].key && this.frames[i].t <= t) return i; return -1; }
    // call often (every animation frame). retainMs: how much history to keep behind now (for a later, bigger delay)
    // full = false (cam not on screen): decode keyframes only, so the canvas holds a recent picture at a fraction of the CPU
    tick(delayMs, retainMs = 0, full = true) {
      const now = performance.now(), target = now - delayMs, fr = this.frames;
      if (full && !this.full) {
        // back on screen: decode from the last keyframe, draw only once caught up with the playhead
        const k = this.keyBefore(target);
        if (k >= 0) { this.resetDecoder(); this.curGen = fr[k].gen; this.pos = k; this.drawFrom = target - 100; }
      }
      this.full = full;
      if (this.lastDecT > target + 250) {
        // delay went up: jump back to a keyframe before the new playhead (if the history has one; otherwise wait)
        const k = this.keyBefore(target);
        if (k >= 0) { this.resetDecoder(); this.curGen = fr[k].gen; this.pos = k; this.lastDecT = -Infinity; this.seeks++; }
      } else if (this.pos < fr.length && target - fr[this.pos].t > 1500) {
        // delay went down a lot: skip ahead to the last keyframe before the playhead
        const k = this.keyBefore(target);
        if (k > this.pos) { this.resetDecoder(); this.curGen = fr[k].gen; this.pos = k; this.seeks++; }
      }
      let n = 0;
      while (this.pos < fr.length && fr[this.pos].t <= target && n++ < 400) {
        const f = fr[this.pos++];
        this.lastDecT = f.t;
        if (f.gen !== this.curGen || f.codec !== this.codec) { this.resetDecoder(); this.curGen = f.gen; this.codec = f.codec; }
        if (f.bad) { this.needKey = true; continue; }     // see lost(): hold the last good picture until a keyframe
        if ((this.needKey || !full) && !f.key) continue;
        if (!this.dec || this.dec.state === 'closed') this.makeDecoder(f);
        try {
          this.dec.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: Math.round(f.t * 1000), data: f.data }));
          this.needKey = false; this.sent++;
        } catch { this.errors++; this.resetDecoder(); }
      }
      // forget frames nobody can need any more (keep from the keyframe that starts the kept history)
      const keepFrom = Math.min(target, now - retainMs);
      let cut = 0, lastKey = -1;
      while (cut < this.pos && fr[cut].t < keepFrom) { if (fr[cut].key) lastKey = cut; cut++; }
      if (lastKey >= 0 && (cut >= fr.length || !fr[cut].key) && fr[lastKey].t > keepFrom - 60000) cut = lastKey;
      if (cut > 60) { fr.splice(0, cut); this.pos -= cut; }
    }
    // buffered seconds, and whether the picture is being shown
    status(delayMs) {
      const now = performance.now();
      return {
        buffered: this.frames.length ? (now - this.frames[0].t) / 1000 : 0,
        filled: this.firstAt ? Math.min(1, (now - this.firstAt) / Math.max(1, delayMs)) : 0,
        receiving: this.lastAt && now - this.lastAt < 3000,
        showing: this.lastShownAt && now - this.lastShownAt < (this.full ? 3000 : 6000),   // off screen: one picture per keyframe (4 s)
        width: this.w, height: this.h, errors: this.errors, lag: Math.round(this.lag), keys: this.keys, seeks: this.seeks, losses: this.losses, codec: this.codec || '', decErr: this.err,
        // H.264 frames go in but no picture ever comes out: this browser (OBS) can't decode H.264
        h264Broken: this.codec === 'h264' && !this.shown && (this.errors >= 3 || this.sent >= 90), keyAgo: this.lastKeyAt ? Math.round((now - this.lastKeyAt) / 1000) : null,
      };
    }
    clear() { this.frames = []; this.pos = 0; this.lastDecT = -Infinity; this.resetDecoder(); this.firstAt = 0; }
  }

  /*
   * DelayAudio: the same for the mic. Keeps the encoded Opus frames (small: ~4 MB per 15 min),
   * decodes them `delay` after they arrived and schedules them into Web Audio.
   * Times come from the RTP timestamps, so network jitter does not make the sound stutter.
   */
  class DelayAudio {
    constructor(ctx, out) {
      this.ctx = ctx; this.out = out; this.frames = []; this.pos = 0; this.dec = null; this.next = 0; this.lastDecT = -Infinity;
      this.base = null; this.delay = 0; this.recv = 0; this.lastAt = 0; this.errors = 0; this.err = ''; this.late = 0; this.played = 0;
    }
    push(frame) {
      const now = performance.now(); this.recv++; this.lastAt = now;
      const ts = frame.timestamp >>> 0;                               // RTP timestamp, 48 kHz
      let t = now;
      if (this.base) {
        let d = (ts - this.base.ts) >>> 0; if (d > 0x7fffffff) d -= 0x100000000;
        const exp = this.base.t + d / 48;
        if (Math.abs(now - exp) > 2000) this.base = { ts, t: now };     // new sender or a long pause: new timeline
        else if (now < exp) { this.base.t -= exp - now; t = now; }      // earliest arrival = the jitter-free timeline
        else { t = exp; if (now - exp > 250) this.base.t += 1; }         // drift slowly if packets stay late
      } else this.base = { ts, t: now };
      this.frames.push({ t, data: frame.data.slice(0) });
    }
    resetDecoder() { try { this.dec && this.dec.state !== 'closed' && this.dec.close(); } catch {} this.dec = null; this.next = 0; }
    makeDecoder() {
      this.dec = new AudioDecoder({ output: (ad) => this.play(ad), error: (e) => { this.errors++; this.err = e.message; this.dec = null; } });
      this.dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
    }
    play(ad) {
      try {
        const ctx = this.ctx, n = ad.numberOfFrames, sr = ad.sampleRate;
        let when = ctx.currentTime + (ad.timestamp / 1000 + this.delay - performance.now()) / 1000;
        if (this.next && Math.abs(when - this.next) < 0.08) when = this.next;   // seamless
        if (when < ctx.currentTime - 0.005) { this.late++; this.next = 0; return; }
        const buf = ctx.createBuffer(1, n, sr), tmp = new Float32Array(n);
        ad.copyTo(tmp, { planeIndex: 0, format: 'f32-planar' });
        buf.copyToChannel(tmp, 0);
        const src = ctx.createBufferSource(); src.buffer = buf; src.connect(this.out); src.start(when);
        this.next = when + n / sr; this.played++;
      } catch (e) { this.errors++; this.err = e.message; } finally { ad.close(); }
    }
    tick(delayMs, retainMs = 0) {
      const now = performance.now(), play = now - delayMs, ahead = play + 700, fr = this.frames;
      this.delay = delayMs;
      if (this.lastDecT > ahead + 300) {                                // delay went up: start again from the new playhead
        let i = Math.min(this.pos, fr.length); while (i > 0 && fr[i - 1].t >= play) i--;
        this.pos = i; this.resetDecoder(); this.lastDecT = -Infinity;
      } else if (this.pos < fr.length && fr[this.pos].t < play - 1000) {  // delay went down: skip what is already late
        while (this.pos < fr.length && fr[this.pos].t < play) this.pos++;
        this.resetDecoder();
      }
      while (this.pos < fr.length && fr[this.pos].t <= ahead) {
        const f = fr[this.pos++]; this.lastDecT = f.t;
        if (!this.dec || this.dec.state === 'closed') this.makeDecoder();
        try { this.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(f.t * 1000), data: f.data })); }
        catch (e) { this.errors++; this.err = e.message; this.resetDecoder(); }
      }
      const keepFrom = Math.min(play, now - retainMs) - 1000;
      let cut = 0; while (cut < this.pos && fr[cut].t < keepFrom) cut++;
      if (cut > 200) { fr.splice(0, cut); this.pos -= cut; }
    }
    receiving() { return this.lastAt && performance.now() - this.lastAt < 3000; }
    clear() { this.frames = []; this.pos = 0; this.lastDecT = -Infinity; this.base = null; this.resetDecoder(); }
  }

  const api_ = { api, publish, pull, getIce, DelayCam, DelayAudio, STUN };
  if (typeof module === 'object' && module.exports) module.exports = api_;
  else root.DBCam = api_;
})(this);
