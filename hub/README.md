# Direborn Broadcast — semua tools siaran, online

Draft overlay, GSI, statistik turnamen, bracket, stat cards, next match, running text, dan player cam — semuanya jalan di **Cloudflare**. PC siaran cukup Dota (nonton DotaTV) + OBS; tidak ada server yang perlu dijalankan di PC. Control panel bisa dibuka dari laptop/HP mana saja (pakai password).

| Bagian | Isi | Biaya |
| --- | --- | --- |
| Worker + Durable Object | Semua halaman, API, GSI, state live (sinkron realtime ke semua overlay), logo/foto yang di-upload | Gratis untuk test · **Workers Paid $5/bulan** untuk siaran |
| R2 (opsional) | Tempat logo/foto kalau mau dipisah dari Durable Object | Gratis s/d 10 GB (butuh kartu di akun) |
| Realtime (Serverless SFU) | Video player cam | Gratis s/d 1.000 GB/bulan |
| GitHub `DirebornEsports/direborn-broadcast` | Kode; tiap perubahan otomatis ter-deploy | Gratis |

## Alamat setelah online

Ganti `ALAMAT` dengan alamat Worker, misalnya `https://direborn-broadcast.<akun>.workers.dev`.

| Halaman | Untuk | Login? |
| --- | --- | --- |
| `ALAMAT/control` | Control panel draft (+ link ke semua panel) | ya |
| `ALAMAT/teams`, `/stats`, `/bracket`, `/cards`, `/camcontrol`, `/lihat`, `/mix` | Panel tim, statistik, bracket, stat cards, player cam, cek cam, mix draw | ya |
| `ALAMAT/overlay` | OBS: bar draft (1920×1080) | tidak |
| `ALAMAT/ingame` | OBS: foto pemain in-game | tidak |
| `ALAMAT/statcards` | OBS: stat cards full screen | tidak |
| `ALAMAT/nextmatch`, `/nextmatch-wide`, `/ticker` | OBS: next match kotak / 16:9 / running text | tidak |
| `ALAMAT/mixdraw` | OBS: mix draw (acak pemain mix ke 2 tim, reveal satu per satu) | tidak |
| `ALAMAT/cam?k=VIEW_KEY` | OBS: player cam (copy URL lengkap dari panel Player cam) | kunci di URL |
| `ALAMAT/kirim?p=Nama&k=PUSH_KEY` | Pemain kirim webcam (link dari panel Player cam) | kunci di URL |
| `ALAMAT/gsi` | Tujuan GSI dari Dota | token GSI |

Overlay OBS bisa dibuka tanpa login tapi hanya bisa membaca; semua perubahan butuh login operator.

## Setup (sekali saja)

### Paket gratis dulu (test)
Bisa jalan di paket gratis Cloudflare. Batasnya 10 ms CPU per request:
- draft, GSI, overlay, control panel, next match, ticker, player cam: ringan (±1–3 ms) → aman;
- stat cards pertama kali dibuka, **Export Excel**, **Update from OpenDota**, dan request pertama setelah server "tidur": bisa kena error *exceeded CPU* — refresh sekali biasanya jalan.
Kalau sudah yakin, upgrade ke **Workers Paid** ($5/bulan) — tidak perlu ubah apa-apa di kode.

### 1. Cloudflare
1. Daftar / login di dash.cloudflare.com.
2. (Untuk siaran) **Workers & Pages → Plans** → **Workers Paid**. Untuk test, lewati.
3. (Opsional) **R2** → **Create bucket** `direborn-uploads`, lalu buka `wrangler.jsonc` dan hilangkan `//` di baris `r2_buckets`. Tanpa R2, logo & foto disimpan di Durable Object.
4. **Realtime** (dulu *Calls*) → **Serverless SFU** → **Create** → catat **App ID** dan **App Token**.
   Opsional: **Realtime → TURN Server → Create** → catat **Key ID** dan **API Token** (untuk pemain yang jaringannya memblok UDP).

### 2. GitHub
Repo `DirebornEsports/direborn-broadcast` berisi folder ini.

### 3. Hubungkan GitHub ke Cloudflare
1. **Workers & Pages → Create → Import a repository** → pilih `direborn-broadcast`.
2. Build command: `npm run build` · Deploy command: `npx wrangler deploy` → **Deploy**.
3. Setelah jadi: Worker `direborn-broadcast` → **Settings → Variables and Secrets** → **Add** (type **Secret**):

| Nama | Isi |
| --- | --- |
| `ADMIN_PASSWORD` | password operator (panjang, jangan dibagikan) |
| `GSI_TOKEN` | token GSI (acak), sama dengan di file .cfg Dota |
| `CF_APP_ID`, `CF_APP_SECRET` | dari langkah 1.4 |
| `PUSH_KEY` | kunci untuk link pemain (acak) |
| `VIEW_KEY` | kunci untuk overlay cam (acak, beda dari PUSH_KEY) |
| `TURN_KEY_ID`, `TURN_KEY_TOKEN` | opsional, dari langkah 1.4 |

4. Buka `ALAMAT/login` → masuk → `ALAMAT/control`.

### 4. Dota (PC siaran)
1. Copy `gsi/gamestate_integration_draftoverlay.cfg` ke `…\dota 2 beta\game\dota\cfg\gamestate_integration\`.
2. Edit: `uri` → `ALAMAT/gsi`, `token` → isi `GSI_TOKEN`. Launch option `-gamestateintegration`. Restart Dota.
3. Cek di control panel → **GSI check**. Kalau "Nothing received yet" padahal sudah benar, Dota mungkin tidak mau kirim ke https: jalankan `gsi/relay-gsi.ps1` (isi alamat Worker di dalamnya) dan ganti `uri` jadi `http://127.0.0.1:3000/`.
4. Anti-snipe GSI delay: **Off** kalau nonton DotaTV (datanya sudah ter-delay).

### 5. OBS
Tambahkan Browser source 1920×1080 dengan alamat-alamat di tabel atas. Centang **Control audio via OBS** untuk sound effect.

### 6. Player cam
`ALAMAT/camcontrol` → pilih tim → **Copy** link tiap pemain → kirim ke pemain → **Copy OBS URL** untuk source cam. Kalibrasi delay dengan tepuk tangan di horn 0:00.

## Data
- Saat pertama jalan, statistik Dire Battle Cup dan roster resmi (Steam ID) otomatis terisi.
- Semua data (tim, statistik, turnamen, bracket, state siaran) tersimpan di Durable Object; logo/foto di R2.
- Backup statistik: tombol **Export Excel** di halaman Stats.
- Mengubah `config.json` (urutan draft, timer), teks stat card manual (`seed/statcards.json`), sound atau media hero di `public/`: edit di GitHub → otomatis ter-deploy.

## Untuk developer
- `npm run dev` — jalankan versi Cloudflare di PC (emulator Node, tanpa akun) di http://localhost:8787 (secret dari `dev/.dev.json`, contoh `dev/dev.example.json`).
- `npm test` — test end-to-end (butuh Playwright): login, draft live, GSI, statistik & Excel, bracket, restart Durable Object, upload R2, player cam dengan delay.
- `node test/vfs.test.cjs` — test penyimpanan.
- Struktur: `src/worker.mjs` (routing, login, R2), `src/hub.js` (server overlay di Durable Object), `src/vfs.js` (file → storage Durable Object), `src/nodeadapter.js`, `lib/` (statistik, kartu, xlsx, relay cam), `public/` (semua halaman).

Fitur lengkap tiap overlay: `docs/fitur-overlay.md`.
