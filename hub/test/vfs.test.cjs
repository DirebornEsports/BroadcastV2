// node test/vfs.test.cjs — the virtual fs over Durable Object storage
const { createFs, memoryKv } = require('../src/vfs.js');
const kv = memoryKv();
const puts = []; const blobs = { put: async (k, d) => puts.push([k, Buffer.from(d).length]), delete: async (k) => puts.push(['del', k]) };
const fs = createFs({ kv, bundle: { 'config.json': '{"a":1}', 'seed/x.json': '[1]' }, manifest: { 'public/sounds/sfx': ['a.wav'] }, blobs });
let fails = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
ok(JSON.parse(fs.readFileSync('/app/config.json', 'utf8')).a === 1, 'bundled read');
ok(fs.existsSync('/app/seed/x.json') && !fs.existsSync('/app/data/none.json'), 'exists');
try { fs.readFileSync('/app/data/none.json', 'utf8'); ok(false, 'missing throws'); } catch (e) { ok(e.code === 'ENOENT', 'missing throws ENOENT'); }
fs.writeFileSync('/app/data/teams.json', JSON.stringify([{ n: 1 }]));
ok(fs.readFileSync('/app/data/teams.json', 'utf8') === '[{"n":1}]', 'write/read');
const big = 'x'.repeat(1234567);
fs.writeFileSync('/app/data/stats-big.json', big);
ok(fs.readFileSync('/app/data/stats-big.json', 'utf8') === big, 'big file in chunks (' + kv.keys('c:data/stats-big.json').length + ' chunks)');
fs.writeFileSync('/app/data/stats-big.json', 'small');
ok(fs.readFileSync('/app/data/stats-big.json', 'utf8') === 'small' && kv.keys('c:').length === 0, 'shrink removes chunks');
fs.writeFileSync('/app/data/stats-big.json', big); fs.renameSync('/app/data/stats-big.json', '/app/data/stats-big.deleted-1.json');
ok(!fs.existsSync('/app/data/stats-big.json') && fs.readFileSync('/app/data/stats-big.deleted-1.json', 'utf8') === big, 'rename big file');
fs.writeFileSync('/app/public/logos/uploads/logo-1.png', Buffer.from([1, 2, 3]));
fs.unlinkSync('/app/public/logos/uploads/logo-1.png');
setTimeout(() => {
  ok(puts[0][0] === 'uploads/logo-1.png' && puts[0][1] === 3 && puts[1][1] === 'uploads/logo-1.png', 'uploads go to R2');
  ok(fs.readdirSync('/app/public/sounds/sfx')[0] === 'a.wav', 'readdir from manifest');
  try { fs.writeFileSync('/app/config.json', 'x'); ok(false, 'bundle read-only'); } catch { ok(true, 'bundle is read-only'); }
  try { fs.readFileSync('/etc/passwd'); ok(false, 'outside'); } catch { ok(true, 'paths outside /app refused'); }
  ok(fs.readFileSync('/app/data/../data/teams.json', 'utf8').length > 0, 'path normalising');
  console.log(fails ? fails + ' FAILED' : 'all passed'); process.exitCode = fails ? 1 : 0;
}, 10);
