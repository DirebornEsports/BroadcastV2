# Brief untuk Claude di PC MikroTik: buka jalur PC pemain → PC Direborn Studio

Tempel file ini ke Claude yang punya akses ke MikroTik (Winbox/terminal/SSH). Tugasnya: bikin PC pemain bisa
mengirim kamera ke PC Studio lewat jaringan lokal, padahal keduanya ada di router / subnet berbeda di belakang MikroTik.

## Situasi
- **PC Studio** menjalankan *Direborn Studio*: server kamera (Node) + receiver. OBS ada di PC yang sama.
- **PC pemain** menjalankan *Direborn Cam*: kirim kamera + mic ke Studio (WHIP/WebRTC) dengan ffmpeg.
- Pencarian otomatis Studio (UDP broadcast ke port 8789) **tidak bisa lewat router** — itu normal, tidak perlu
  dibuat jalan. Pemain akan mengisi **IP Studio manual** di app Cam.
- Dari PC pemain, `Test-NetConnection <IP Studio> -Port 8787` saat ini gagal / atau belum dites.

## Isi dulu (tanya ke user kalau belum tahu)
- IP PC Studio: `__________` (di PC Studio: `ipconfig`, IPv4 adapter yang dipakai)
- Subnet PC Studio: `__________`   Subnet PC pemain: `__________`
- Apakah di antara keduanya ada router lain (bukan MikroTik) yang melakukan NAT? `ya / tidak`

## Lalu lintas yang harus lolos (dari subnet pemain → IP PC Studio)
| Protokol | Port tujuan di PC Studio | Untuk apa |
|---|---|---|
| TCP | 8787 | Daftar PIN + signaling WHIP kamera |
| UDP | 1024–65535 | Media video/audio (WebRTC, werift). Port dipilih acak tiap koneksi, belum ada rentang tetap |
| TCP | 8080 | (hanya kalau PC observer Dota beda dari PC Studio) GSI dari Dota ke Studio |

Balasan dari Studio ke pemain cukup lewat aturan *established/related* biasa.

## Syarat penting soal NAT
- PC pemain **boleh** di belakang NAT (koneksi selalu dimulai dari pemain).
- PC Studio **tidak boleh** di belakang NAT yang tidak bisa dijangkau dari subnet pemain: Studio memberi tahu
  pemain IP LAN-nya sendiri, dan pemain mengirim UDP langsung ke IP itu (port acak, jadi port-forward tidak praktis).
  Kalau Studio ada di belakang router kecil dengan NAT: pindahkan PC Studio ke jaringan utama MikroTik, atau jadikan
  router kecil itu mode bridge/AP, atau buat routing tanpa NAT ke subnet Studio.
- Pakai **IP tetap** untuk PC Studio (static DHCP lease di MikroTik), supaya pemain tidak perlu ganti alamat.

## Cara kerja yang diminta (urutan)
1. **Backup dulu** sebelum mengubah apa pun: `/export file=backup-sebelum-direborn` (dan/atau `/system backup save`).
2. Baca kondisi sekarang, jangan ubah dulu:
   `/ip address print`, `/ip route print`, `/ip firewall filter print`, `/ip firewall nat print`,
   `/interface bridge port print`, `/ip dhcp-server lease print`.
3. Jelaskan ke user: jalur paket pemain → Studio sekarang lewat mana, dan di mana terhalang (routing, NAT, atau filter).
4. Usulkan perubahan **seminimal mungkin** dan minta persetujuan user sebelum menerapkan. Contoh bentuknya
   (sesuaikan nama/subnet, taruh di atas aturan drop):
   ```
   /ip firewall filter add chain=forward src-address=<subnet pemain> dst-address=<IP Studio> protocol=tcp dst-port=8787 action=accept comment="Direborn Cam signaling" place-before=0
   /ip firewall filter add chain=forward src-address=<subnet pemain> dst-address=<IP Studio> protocol=udp dst-port=1024-65535 action=accept comment="Direborn Cam media" place-before=0
   ```
   Hanya kalau dibutuhkan: route statis ke subnet Studio, atau pengecualian NAT (`srcnat` jangan me-masquerade
   lalu lintas pemain → Studio kalau itu mengganggu).
5. Jangan matikan firewall seluruhnya, jangan buka port ke internet (WAN), jangan ubah DNS/DHCP selain lease Studio.

## Cek berhasil
- Dari PC pemain: `Test-NetConnection <IP Studio> -Port 8787` → `TcpTestSucceeded : True`.
- Dari PC pemain, browser: `http://<IP Studio>:8787/` → dashboard kamera Direborn terbuka.
- Di app Direborn Cam: isi alamat studio = IP Studio, masukkan PIN, kirim → kamera muncul di dashboard Studio.
- Kalau TCP 8787 tembus tapi video tidak muncul: yang terhalang UDP (cek aturan UDP / NAT di atas).

## Firewall Windows di PC Studio (bukan MikroTik, tapi sering jadi penyebab)
Saat Studio dibuka, Windows minta izin admin untuk aturan firewall "Direborn Studio (Node)" dan
"Direborn Studio (receiver)". Cek: `netsh advfirewall firewall show rule name="Direborn Studio (Node)"`.
Kalau tidak ada: tutup Studio, buka lagi, klik **Yes**. Profil jaringan PC Studio sebaiknya **Private**.

## Rencana cadangan
Kalau jalur lokal tidak bisa dibuka: pakai mode **Online** Direborn Studio (relay Cloudflare), tidak perlu
mengubah MikroTik sama sekali, asal kedua PC punya internet.
