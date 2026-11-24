// node test/delaycam.test.cjs — DelayCam: off screen only keyframes are decoded, back on screen it resumes from the last keyframe
let now = 0;
global.performance = { now: () => now };
const decoded = [], configured = [];                       // every chunk handed to the decoder: [type, arrival ms]
global.EncodedVideoChunk = class { constructor(o) { Object.assign(this, o); } };
global.VideoDecoder = class {
  constructor({ output }) { this.output = output; this.state = 'configured'; }
  configure(c) { configured.push(c.codec); }
  decode(c) { decoded.push([c.type, c.timestamp / 1000]); this.output({ timestamp: c.timestamp, displayWidth: 16, displayHeight: 9, close() {} }); }
  close() { this.state = 'closed'; }
};
const { DelayCam } = require('../public/camrtc.js');
const drawn = [];
let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
// 10 s of video at 10 fps, a keyframe every 4 s (at 0, 4000, 8000)
function cam() {
  const dc = new DelayCam({ width: 0, height: 0, getContext: () => ({ drawImage: () => drawn.push(now) }) });
  for (let t = 0; t < 10000; t += 100) { now = t; dc.push({ type: t % 4000 === 0 ? 'key' : 'delta', data: new ArrayBuffer(4) }); }
  decoded.length = 0; drawn.length = 0;
  return dc;
}

let dc = cam();
now = 7000; dc.tick(1000, 0, false);      // off screen, playhead 6000
ok(decoded.length === 1 && decoded[0][0] === 'key' && decoded[0][1] === 4000, 'off screen: only the latest keyframe before the playhead is decoded');
ok(dc.status(1000).showing, 'off screen: still counts as showing (picture from the last keyframe)');
now = 9100; dc.tick(1000, 0, false);      // playhead 8100: passes the keyframe at 8000 and deltas
ok(decoded.length === 2 && decoded.every(([type]) => type === 'key'), 'off screen: deltas are skipped, the next keyframe is decoded');

dc = cam();
now = 7000; dc.tick(1000, 0, false);
decoded.length = 0; drawn.length = 0;
now = 7500; dc.tick(1000, 0, true);       // on screen, playhead 6500
ok(decoded[0] && decoded[0][0] === 'key' && decoded[0][1] === 4000, 'back on screen: resumes from the keyframe at 4000');
ok(decoded.length === 26 && decoded[decoded.length - 1][1] === 6500, 'decodes every frame from 4000 up to the playhead');
ok(drawn.length === 2, 'draws only the last 100 ms before the playhead (6400, 6500), not the catch-up from 4000');
decoded.length = 0;
now = 7700; dc.tick(1000, 0, true);
ok(decoded.length === 2 && decoded.every(([type]) => type === 'delta'), 'on screen: keeps decoding every frame');

// a frame lost at ~9300: the browser asked for a keyframe between the polls at 9400 and 9650; the answer came at 9700
dc = cam();                               // frames 0..9900, keyframes at 0, 4000, 8000
dc.frames.find((f) => f.t === 9700).key = true;
now = 9900; dc.lost(9400);                // marks 8400..9600 (window 1500 ms), not the answer at 9700 nor after it
const bad = dc.frames.filter((f) => f.bad).map((f) => f.t);
ok(bad[0] === 8400 && bad[bad.length - 1] === 9600 && bad.length === 13, 'loss: frames before the answering keyframe are marked bad');
decoded.length = 0; now = 10900; dc.tick(1000, 0, true);
ok(!decoded.some(([, t]) => t >= 8400 && t < 9700), 'loss: bad frames are never decoded (picture holds)');
ok(decoded.some(([type, t]) => type === 'key' && t === 9700) && decoded.some(([, t]) => t === 9800), 'loss: plays on from the answering keyframe');
dc = cam();
now = 9900; dc.lost(9800);                // no answer yet: everything from the window start on is bad
ok(dc.frames.filter((f) => f.bad).length === 16 && dc.frames.find((f) => f.t === 9900).bad, 'loss without an answer yet: marks 8400 up to now');

// H.264: frames start with an Annex B start code; the decoder gets the profile/level from the keyframe's SPS
{
  const sps = [0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac], idr = [0, 0, 0, 1, 0x65, 1], p = [0, 0, 0, 1, 0x41, 2];
  const h = new DelayCam({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) });
  for (let t = 0; t < 1000; t += 100) { now = t; h.push({ type: t === 0 ? 'key' : 'delta', data: new Uint8Array(t === 0 ? [...sps, ...idr] : p).buffer }); }
  // a sender switching to VP8 (new connection): a fresh decoder with the VP8 config
  h.newSource(); for (let t = 1000; t < 1300; t += 100) { now = t; h.push({ type: t === 1000 ? 'key' : 'delta', data: new Uint8Array([0x10, 2, 0, 0x9d, 1, 0x2a]).buffer }); }
  configured.length = 0; decoded.length = 0;
  now = 1400; h.tick(100, 0, true);
  ok(configured[0] === 'avc1.640028' && configured[1] === 'vp8', 'H.264 decoder set up from the SPS (avc1.640028), then VP8 after the switch: ' + configured.join(', '));
  ok(decoded.length === 13, 'every H.264 and VP8 frame decoded');
  ok(!h.status(100).h264Broken, 'pictures came out: not flagged as broken');
  const x = new DelayCam({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) });
  x.codec = 'h264'; x.errors = 3;
  ok(x.status(100).h264Broken, 'H.264 errors and never a picture: flagged, so the Hub switches senders to VP8');
}

process.exit(fails ? 1 : 0);
