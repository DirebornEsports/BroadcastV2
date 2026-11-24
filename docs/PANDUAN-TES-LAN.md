# Tes Player Cam 2.0 di LAN (bootcamp / venue)

Semua PC di router yang sama. Tidak butuh internet.

```
PC pemain (kamera)  --WHIP-->  PC studio: bridge :8787  -->  studio-recv (delay)  --UDP-->  OBS Media Source
```

## 1. PC studio (yang menjalankan OBS)
Sekali saja:
1. Pasang **Node.js** (nodejs.org, LTS) dan **ffmpeg**: buka PowerShell, `winget install Gyan.FFmpeg`.
2. Copy folder paket ini ke PC studio (misal `C:\DirebornCam`).
3. Catat IP PC studio: PowerShell → `ipconfig` → **IPv4 Address** (misal `192.168.1.10`).

Setiap tes:
1. Buka `studio\start-cams.bat` dengan Notepad, ganti daftar nama pemain kalau perlu (default: Dreamocel, woMy, PotaT2, db-, dalul), simpan.
2. Double-click `studio\start-cams.bat`.
   - Muncul jendela kecil "Direborn bridge" (biarkan terbuka).
   - Pertama kali, Windows Firewall bertanya soal **Node.js**: centang **Private networks** → **Allow**. Tanpa ini kamera pemain tidak bisa masuk.
3. Jendela studio menampilkan tiap pemain + port-nya: `menunggu cam...` lalu `LIVE` setelah pemain mulai kirim.
4. **OBS**, untuk tiap pemain: Sources → **+** → **Media Source** →
   - hilangkan centang **Local File**,
   - Input: `udp://127.0.0.1:5000` (port sesuai di jendela studio: pemain pertama 5000, kedua 5001, dst.),
   - centang **Use hardware decoding when available**,
   - hilangkan centang **Restart playback when source becomes active**.
   - suara mic pemain ikut di source yang sama: atur volumenya di Audio Mixer OBS.

**Delay** (sama untuk semua cam), di jendela studio:
- ketik angka lalu Enter: delay baru dalam detik (mis. `900` = 15 menit, maks. 1020),
- `+0.5` / `-0.5`: geser sedikit untuk sinkron horn,
- `q`: stop semua.
Menaikkan delay = gambar diam sebentar sampai buffer cukup. Menurunkan delay = gambar loncat ke keyframe berikutnya (≤ 2 detik). Cam yang baru tersambung butuh satu delay penuh sebelum tampil.

## 2. PC pemain
Sekali saja: `winget install Gyan.FFmpeg` (PowerShell), lalu copy folder `pemain`.

Setiap tes: double-click `pemain\kirim.bat`.
1. Muncul daftar kamera dan mic di PC itu.
2. Isi **nama pemain** (harus sama persis dengan di jendela studio), **nama kamera** dan **nama mic** (persis seperti daftar; mic boleh dikosongkan = tanpa suara), **IP PC studio**.
3. Baris `Encoder: h264_nvenc (GPU)` / `h264_amf` / `h264_qsv` = pakai GPU. `libx264 (software / CPU)` = tidak ada encoder GPU, lapor ke operator.
4. Biarkan jendelanya terbuka selama main. Kalau putus, otomatis sambung lagi dalam 3 detik.

Kualitas default 1080p30, 4,5 Mbps. Lebih ringan: `kirim.bat -Name woMy -Camera "..." -Bridge http://192.168.1.10:8787 -Size 1280x720 -Kbps 2500`.

## 3. Yang dicatat saat tes
| Tes | Catat |
|---|---|
| Pemain main Dota sambil kirim cam | FPS Dota dengan dan tanpa cam (pakai overlay FPS Dota / Steam) |
| 5 cam sekaligus | Task Manager PC studio: CPU, GPU "Video Decode", RAM OBS |
| Delay 900 (15 menit) | Gambar stabil? Jam di jendela studio sesuai? |
| Horn sync | Berapa delay akhir yang pas dengan DotaTV |
| Sinkron suara | Pemain tepuk tangan di depan kamera: bunyi pas dengan gambar di OBS? Ulangi setelah restart `start-cams` |
| PC pemain NVIDIA | Baris `Encoder: h264_nvenc`, dan `dari pemain` di jendela studio tetap 0 (belum pernah dites) |
| Cabut kabel pemain 10 detik, colok lagi | Berapa detik sampai cam kembali (setelah delay) |
| 2–3 jam jalan terus | Ada yang mati / patah-patah? (lihat folder `studio\logs`) |

## Kalau ada masalah
- **Studio terus `menunggu cam...`**: nama pemain beda (huruf besar/kecil tidak masalah, spasi/tanda baca masalah), IP salah, atau Firewall memblokir Node di PC studio.
- **Pemain: "Could not find video device"**: nama kamera tidak persis sama, atau kamera dipakai aplikasi lain (Discord, OBS, Zoom).
- **OBS hitam**: port salah, atau delay belum lewat (cam baru tampil setelah satu delay penuh).
- **`hilang` / `dari pemain` naik terus**: paket hilang di jaringan atau di PC pemain. Catat encoder pemain itu (baris `Encoder:`) dan kirim screenshot jendela studio.
- **Windows Firewall memblokir**: di PC studio izinkan Node.js, di PC pemain izinkan ffmpeg (Private networks).
- Log tiap cam: `studio\logs\<nama>.log` dan `<nama>.status.log`.

## Yang belum ada di prototype ini
Belum ada panel web (delay diatur dari jendela studio), satu port UDP per cam, belum ada mode online (pemain dari rumah).
