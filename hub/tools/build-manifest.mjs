// Lists the sound and hero media files in public/ so the online server knows what's there
// (a Worker can't list its static files). Runs as the build step: npm run build
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // URL.pathname gives /C:/... on Windows
const dirs = ['public/sounds', 'public/sounds/heroes', 'public/sounds/sfx', 'public/heroes'];
const out = {};
for (const d of dirs) {
  try { out[d] = fs.readdirSync(path.join(root, d)).filter((f) => fs.statSync(path.join(root, d, f)).isFile()).sort(); } catch { out[d] = []; }
}
out.__build = String(Date.now());          // lets the running Durable Object notice a newer deploy and restart itself
fs.mkdirSync(path.join(root, 'src/generated'), { recursive: true });
fs.writeFileSync(path.join(root, 'src/generated/manifest.json'), JSON.stringify(out, null, 1) + '\n');
console.log('manifest:', Object.entries(out).map(([k, v]) => `${k} ${v.length}`).join(', '));
