// Small copies of the animated hero portraits, served from Cloudflare with the site (public/heroes-anim/<slug>.webm).
// Valve's are 1440 x 1440 VP9 with transparency at 24 fps: ten of them in a full draft are decoded on the CPU (no
// graphics card decodes VP9 with transparency) to fill 100 x 134 px cards. These are 480 x 480, ~1/9 of the work.
//   node tools/shrink-portraits.mjs        (needs ffmpeg; skips heroes already done, so run it again after a new hero)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'heroes-anim');
const CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/videos/dota_react/heroes/renders/';
const SIZE = 480;
fs.mkdirSync(OUT, { recursive: true });

const run = (args) => new Promise((ok, no) => execFile('ffmpeg', args, (e, _o, err) => (e ? no(new Error(String(err).trim().split('\n').pop())) : ok())));
const heroes = await fetch('https://api.opendota.com/api/heroes').then((r) => r.json());
const slugs = heroes.map((h) => String(h.name).replace('npc_dota_hero_', '')).filter((s) => !fs.existsSync(path.join(OUT, s + '.webm')));
console.log(`${heroes.length} heroes, ${slugs.length} to make`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portraits-'));
let done = 0, failed = 0;
async function one(slug) {
  const src = path.join(tmp, slug + '.webm'), dst = path.join(OUT, slug + '.webm');
  const r = await fetch(CDN + slug + '.webm');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  fs.writeFileSync(src, Buffer.from(await r.arrayBuffer()));
  // libvpx decodes the transparency (ffmpeg's own VP9 decoder drops it); no audio; alt-ref off keeps the alpha
  await run(['-v', 'error', '-y', '-c:v', 'libvpx-vp9', '-i', src, '-an', '-vf', `scale=${SIZE}:${SIZE}`, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
    '-auto-alt-ref', '0', '-b:v', '0', '-crf', '34', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', dst + '.part.webm']);
  fs.renameSync(dst + '.part.webm', dst);
  fs.unlinkSync(src);
}
const queue = [...slugs];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let s; (s = queue.shift());) {
    try { await one(s); done++; } catch (e) { failed++; console.log(`  ${s}: ${e.message}`); }
    if ((done + failed) % 10 === 0) console.log(`  ${done + failed}/${slugs.length}`);
  }
}));
fs.rmSync(tmp, { recursive: true, force: true });
const total = fs.readdirSync(OUT).reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`done: ${done} made, ${failed} failed; public/heroes-anim is ${(total / 1048576).toFixed(1)} MB`);
