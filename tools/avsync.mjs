// A/V sync check for the receiver output: run the sender with -Camera test -Mic test (white flash + beep
// every 2 s), then:  node tools/avsync.mjs udp://127.0.0.1:5096
// Prints how far the beep lands from the flash (negative = sound early).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const src = process.argv[2] || 'udp://127.0.0.1:5000';
const dir = mkdtempSync(join(tmpdir(), 'avsync-'));
const ts = join(dir, 'av.ts');
const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', ...a], { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
const url = src.startsWith('udp://') ? `${src}${src.includes('?') ? '&' : '?'}timeout=15000000` : src;
ff('-i', url, '-t', process.argv[3] || '15', '-c', 'copy', '-y', ts);
ff('-i', ts, '-an', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=v.txt', '-f', 'null', '-');
ff('-i', ts, '-vn', '-af', 'asetnsamples=480,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=a.txt', '-f', 'null', '-');

const series = (file, key) => {
  const out = []; let t;
  for (const l of readFileSync(join(dir, file), 'utf8').split(/\r?\n/)) {
    const m = /pts_time:([\d.]+)/.exec(l); if (m) t = +m[1];
    const v = l.split(key + '=')[1]; if (v !== undefined) out.push([t, parseFloat(v)]);
  }
  return out;
};
const onsets = (s, th) => { const r = []; let prev = false; for (const [t, v] of s) { const hi = v > th; if (hi && !prev) r.push(t); prev = hi; } return r; };
const v = onsets(series('v.txt', 'lavfi.signalstats.YAVG'), 200);
const a = onsets(series('a.txt', 'lavfi.astats.Overall.RMS_level'), -30);
const d = v.map((tv) => (a.reduce((b, x) => (Math.abs(x - tv) < Math.abs(b - tv) ? x : b), Infinity) - tv) * 1000).filter((x) => Math.abs(x) < 1000);
if (!d.length) { console.log(`no flash/beep pairs found (flashes ${v.length}, beeps ${a.length})`); process.exit(1); }
const s = [...d].sort((x, y) => x - y);
console.log(`flashes ${v.length}, beeps ${a.length}; audio minus video: median ${s[s.length >> 1].toFixed(0)} ms, min ${s[0].toFixed(0)}, max ${s[s.length - 1].toFixed(0)}`);
console.log(`over time: ${d.map((x) => x.toFixed(0)).join(' ')}`);
