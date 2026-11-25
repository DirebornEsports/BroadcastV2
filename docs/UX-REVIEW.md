# Review UX dashboard operator (25 Nov 2026)

Ditelusuri: Draft control (tab Draft, Setup, On air, Check), Kamera, Teams, Statistik, Bracket, Stats cards, Mix draw.
Sudut pandang: operator saat **siaran live** (cepat, tanpa salah klik) dan saat **persiapan** (isi data).

## Masalah, diurutkan dari dampak terbesar

| # | Masalah | Dampak saat live | Bukti |
|---|---|---|---|
| 1 | **Tidak ada satu tempat untuk melihat "apa yang sedang tayang".** Status overlay tersebar di header Draft control (pill kecil "Overlay: shown"), 10 panel di tab On air, halaman Stats cards, dan halaman Kamera. | Tinggi: operator bisa lupa running text / banner / countdown masih tampil. | 7 overlay punya `visible` sendiri-sendiri, tidak ada ringkasan. |
| 2 | **Tab On air = satu kolom panjang 4.089 px berisi 10 panel**, yang sering dipakai (stat card, next match, running text) bercampur dengan pengaturan yang jarang disentuh (volume sound effect, karakter chat YouTube, posisi popup). | Tinggi: harus scroll jauh saat butuh cepat. | 10 panel, 120+ tombol, urutan tidak berdasarkan frekuensi. |
| 3 | **Teks bantuan panjang di mana-mana** (33 paragraf petunjuk), ditampilkan penuh setiap saat. | Sedang: menenggelamkan tombol yang penting. | Statistik, Stats cards, On air. |
| 4 | **Header Draft control terlalu padat**: 4 tab + mode Manual/Auto + tombol overlay + 2 status + Copy OBS URL dalam satu baris. Mode draft (Manual vs GSI) yang paling kritis tampil kecil. | Sedang. | Header 1 baris, 9 kontrol. |
| 5 | **Bahasa campur** Inggris/Indonesia ("Match setup", "Load teams", "Hero stats popup", "Delete" di samping teks Indonesia). | Rendah–sedang: memperlambat operator baru. | Hampir semua judul panel. |
| 6 | **Kamera di server lain** (port 8787) dengan sidebar sendiri; pemilih turnamen hanya di panel v1. | Rendah: navigasi terasa dua aplikasi. | |
| 7 | Konfirmasi hapus/reset sudah ada, tapi berbahasa Inggris. | Rendah. | `confirm()` di Draft control, Statistik. |

Yang sudah baik dan dipertahankan: urutan langkah draft (strip B1…P5), shortcut keyboard draft, pratinjau stat card, editor bracket dengan "Unsaved changes", halaman Kamera baru.

## Redesign yang dikerjakan
1. **Dock "On air"** di bawah setiap halaman operator: semua overlay dalam satu baris (Draft, Stat card, Next match, Running text, Countdown, Banner, Caster, Karakter chat) dengan status hidup/mati, **klik = tampil/sembunyi**, plus status GSI dan koneksi. Menjawab masalah 1 dan 4.
2. **Tab On air disusun ulang**: dua kolom; atas = yang sering dipakai saat live (Stats cards, Next match, Running text, Countdown, Banner, Caster); bawah = **Pengaturan** yang terlipat (popup hero & GSI, in-game card, karakter chat, sound effect) dan dibuka dengan klik judulnya. Masalah 2.
3. **Petunjuk panjang dilipat** jadi satu baris; klik untuk membaca semuanya. Masalah 3.
4. **Header Draft control dirampingkan**: tombol overlay, Copy OBS URL dan link lama pindah ke dock/sidebar; mode draft jadi segmented "Manual / Otomatis (GSI)" yang jelas. Masalah 4.
5. **Bahasa Indonesia** untuk judul panel, label dan tombol utama di semua halaman. Masalah 5 dan 7.

## Tahap 2 (tab Draft dan halaman persiapan)
| Halaman | Masalah | Redesign |
|---|---|---|
| Draft | "Giliran siapa, pick/ban" hanya teks kecil di atas jam; grid hero terpotong; shortcut tidak terlihat | Banner **Giliran** besar berwarna tim + chip BAN/PICK; baris cari menempel dengan chip giliran; baris shortcut |
| Persiapan | Form tim kiri dan kanan ditumpuk; cache gambar & framing portrait selalu terbuka | Form tim kiri/kanan berdampingan; cache & framing dilipat |
| Cek | Label Inggris | Bahasa Indonesia |
| Teams | Daftar tim tersimpan (paling sering dilihat) di bawah; laporan impor roster sangat panjang | Tim tersimpan di atas; laporan impor dibatasi tinggi; impor dari tiket liga dilipat |
| Statistik | Halaman panjang tanpa navigasi | Bar lompat ke bagian (Turnamen, Ringkasan, Tautkan pemain, Hero, Match) |
| Bracket | Pengaturan format selalu terbuka di atas daftar match | Pengaturan dilipat; bar lompat ke bagian |
| Stats cards, Mix draw | Sudah cukup jelas | Hanya dock On air dan label |
