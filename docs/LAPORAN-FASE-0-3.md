# Laporan fase 0–3 (dikerjakan semalam, 24–25 Nov 2026)

Semua fase 0–3 selesai dan dites di PC ini. Tampilan sengaja **barebone** (putih/abu-abu, tanpa animasi). Desain = fase 4.
Belum di-push ke GitHub (commit lokal di `main`).

## Installer (folder `dist/`)
| File | Untuk | Ukuran |
|---|---|---|
| `Direborn Studio_0.1.0_x64-setup.exe` | PC studio / OBS | 83 MB |
| `Direborn Cam_0.1.0_x64-setup.exe` | PC tiap pemain (dan team cam) | 1,9 MB |

Belum di-sign: Windows akan menampilkan "Windows protected your PC" → **More info → Run anyway**.

## Alur pemakaian
**Studio**
1. Buka Direborn Studio. Layar "Cek kebutuhan" mengecek Node.js dan ffmpeg; yang belum ada bisa di-install dari tombolnya (winget, butuh internet sekali).
2. App menjalankan server v1 (port 8080) dan bridge kamera (port 8787), lalu membuka **Draft control** v1. Semua fitur v1 ada: draft + GSI, on air, turnamen, tim, statistik, bracket, stat cards. Tanpa login dari PC ini.
3. Menu kiri **Kamera 2.0** → dashboard kamera:
   - **Buat PIN dari database tim**: setiap pemain dan setiap tim (team cam) dapat PIN 4 digit (PIN lama tidak berubah).
   - Slot kamera mengikuti tim kiri/kanan yang di-load di Draft control. Port OBS tetap per posisi:
     `5001–5005` = pemain kiri 1–5, `5006–5010` = pemain kanan 1–5, `5011`/`5012` = team cam kiri/kanan,
     **`5000` = cam otomatis** (ikut hero yang dipilih observer lewat GSI, pindah tepat di keyframe).
   - Delay satu untuk semua kamera (0–1020 detik), tombol ±0,5 dan 15 menit.
4. OBS: Media Source, Local File off, Input `udp://127.0.0.1:<port>`, centang hardware decoding. Overlay v1 tetap browser source `http://localhost:8080/...`.
5. Dota (PC observer): file GSI `uri` → `http://<IP PC studio>:8080/gsi`.

**Pemain**
1. Buka Direborn Cam → cek ffmpeg (bisa install dari tombol).
2. Pilih kamera dan mic (ada preview kamera dan bar level mic, plus info encoder GPU/CPU).
3. Masukkan **PIN** → app menemukan PC studio sendiri (atau ketik IP) dan menampilkan "Kamu: <nama>".
4. Kirim. Tutup jendela = berhenti. Putus = sambung ulang sendiri.

## Yang sudah dites (di PC ini)
- Installer Studio: install diam-diam → jalan di port normal → cam test masuk lewat PIN → slot L1 LIVE (AMD GPU, 30 fps, 0 paket hilang, ada mic) → port 5001 dan 5000 ter-decode **0 error** dengan audio → tutup app: tidak ada proses tersisa → uninstall bersih.
- GSI palsu (format spectator): observer pilih hero kiri P1 → cam otomatis L1; pilih kanan P1 → R1.
- Cam otomatis pindah 2× selama rekaman: **0 error decode** (dipindah hanya di keyframe video).
- PIN salah → ditolak (403). Nama pemain kanji (Kiyotaka倒れた) jalan karena nama diambil dari PIN.
- Delay dari dashboard → semua receiver ikut dalam ±1 detik; di luar 0–1020 ditolak.
- App Player (dites agent): PIN salah/benar, stop, sambung ulang otomatis saat bridge mati-hidup, tutup app tanpa ffmpeg tersisa, installer install/uninstall.
- Sinkron audio-video (gambar tes + beep, lewat installer): suara **~140 ms telat** dari gambar, stabil.
- Halaman v1 barebone: control panel, teams, overlay draft (hero, nama, skor terbaca; art dekoratif hilang).

## Bug yang ketemu dan sudah dibetulkan malam ini
- `kirim.ps1`: nilai `-max_au_size` AMD membuat daftar argumen terulang 1000× (dari perubahan batas keyframe NVIDIA) → encoder AMD gagal. Sudah dibetulkan (dan versi app Player benar dari awal).
- `kirim.ps1` tanpa mic: `-an` terkirim per huruf → ffmpeg gagal. Sudah dibetulkan.
- Cam otomatis awalnya pindah di paket **audio** yang ditandai "random access" → gambar rusak ±2 detik tiap pindah. Sekarang hanya di keyframe video.
- Script build v1 (`build-manifest`) gagal di Windows (path). Sudah dibetulkan.

## Belum dites / risiko
1. **Kamera asli lewat app Player** (OsmoPocket4 tidak tercolok semalam) dan encoder AMD di dalam app saat live. Encoder NVIDIA (NVENC) belum pernah dites sama sekali.
2. **Tombol Install (winget)** di kedua app belum diklik beneran (PC ini sudah punya Node/ffmpeg). Coba di PC bersih.
3. **App ditutup paksa** (Task Manager/crash): server/ffmpeg di belakangnya tetap jalan, start berikutnya bilang "port sudah dipakai". Perlu Windows Job Object (belum dibuat).
4. **Firewall PC studio**: Node harus diizinkan (TCP 8080 untuk GSI dari PC observer, TCP 8787 + UDP untuk kamera, UDP 8789 untuk pencarian studio). Belum otomatis dari installer.
5. Sinkron audio ~140 ms telat dan bisa beda tiap restart receiver.
6. Barebone overlay dibuat dengan CSS umum: beberapa overlay lain (stat cards, next match, ticker) mungkin terlihat aneh — itu wajar sampai fase 4.
7. Test Playwright v1 (`hub/test/run.mjs`) belum dijalankan (Playwright belum ter-install).
8. Mode online (pemain dari rumah lewat Cloudflare Worker) belum termasuk fase 0–3.
9. Di PC ini masih ada **5 receiver lama dari paket tes LAN kemarin** (`Documents\direborn-cam-lan-test`) yang jalan sendiri. Matikan: `taskkill /IM studio-recv.exe /T /F`.

## Struktur repo
| Folder | Isi |
|---|---|
| `hub/` | v1 (draft, GSI, turnamen, stats, on air, overlay) — jalan lokal, barebone |
| `bridge/` | bridge kamera: WHIP, SFU LAN, PIN, discovery, slot, cam otomatis, dashboard |
| `studio/` | receiver Rust (delay, audio, output MPEG-TS) |
| `studio-app/` | app Direborn Studio (Tauri) |
| `player/` | app Direborn Cam (Tauri) |
| `sender/` | sender lama berbasis script (masih dipakai paket tes LAN) |
| `tools/` | `build-studio.ps1`, `make-kit.ps1`, `avsync.mjs` |
