// Small pick-card videos for the Direborn sketch overlay: public/heroes-anim/<hero>.webm (480 px) ->
// public/heroes-card/<hero>.webm, 240 px, with the red-black duotone + halftone dots baked in, so OBS only decodes
// a tiny video per card and does no CSS filters / blending per frame.
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
// grey + contrast, mapped to black -> #ff2a40, then multiplied by a 5 px dot screen (dots at ~45 %)
const filter = '[0:v]scale=240:240,format=gray,eq=contrast=1.45:brightness=0.1:gamma=1.15,format=gbrp,colorchannelmixer=rr=1:gg=0.165:bb=0.25[c];' +
  "color=white:s=240x240,format=gray,geq=lum='if(lt(hypot(mod(X\\,5)-2.5\\,mod(Y\\,5)-2.5)\\,1.2)\\,115\\,255)',format=gbrp[d];" +
  '[c][d]blend=all_mode=multiply:shortest=1,format=yuv420p';
let made = 0;
for (const h of heroes) {
  const dst = path.join(out, h + '.webm');
  if (!only && fs.existsSync(dst)) continue;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(src, h + '.webm'), '-filter_complex', filter, '-an',
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', dst], { stdio: 'inherit' });
  if (r.status !== 0) { console.error('failed:', h); process.exitCode = 1; continue; }
  made++;
}
console.log(`heroes-card: ${made} made, ${heroes.length} heroes`);
