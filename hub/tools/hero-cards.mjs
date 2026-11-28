// Small pick-card videos for the Direborn sketch overlay (/draft): public/heroes-anim/<hero>.webm (480 px) ->
// public/heroes-card/<hero>.webm, 280 px, natural colours with the transparent background kept (VP9 alpha), so the hero
// can stand over the card's red background and out of its frame. Small enough that OBS decodes 10 of them easily.
//   node tools/hero-cards.mjs            (all heroes, skips ones already made)
//   node tools/hero-cards.mjs juggernaut (one hero, always remade)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'public/heroes-anim'), out = path.join(root, 'public/heroes-card');
fs.mkdirSync(out, { recursive: true });
const only = process.argv[2];
const heroes = only ? [only] : fs.readdirSync(src).filter((f) => f.endsWith('.webm')).map((f) => f.slice(0, -5));
let made = 0;
for (const h of heroes) {
  const dst = path.join(out, h + '.webm');
  if (!only && fs.existsSync(dst)) continue;
  // libvpx decoder before -i: ffmpeg's native vp9 decoder drops the alpha channel
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-c:v', 'libvpx-vp9', '-i', path.join(src, h + '.webm'), '-vf', 'scale=280:280', '-an',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '44', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', dst], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('failed:', h); process.exitCode = 1; continue; }
  made++;
}
console.log(`heroes-card: ${made} made, ${heroes.length} heroes`);
