# Direborn Cam sender (2.0 prototype): webcam -> GPU H.264 -> WHIP bridge.
# The Tauri app will run the same ffmpeg command; this script is the stand-in until then.
#   .\sender\kirim.ps1 -Name Dreamocel -Camera "OsmoPocket4"
#   .\sender\kirim.ps1 -Name Test -Camera test          (test pattern, no camera)
#   .\sender\kirim.ps1 -Name Dreamocel -Camera "OsmoPocket4" -Mic "Microphone (USB)"
#   .\sender\kirim.ps1 -List                             (camera and mic names on this PC)
param(
  [string]$Name,
  [switch]$List,
  [string]$Camera = 'test',
  [string]$Mic = '',          # empty = no sound; 'test' = a beep every second (with -Camera test)
  [string]$Bridge = 'http://127.0.0.1:8787',
  [string]$Pin = '',          # Direborn Studio: the player's 4-digit PIN
  [int]$Kbps = 4500,
  [string]$Size = '1920x1080',
  [int]$Fps = 30
)
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { throw 'ffmpeg belum terpasang: jalankan  winget install Gyan.FFmpeg  lalu buka jendela baru' }
if ($List) {
  $dev = & ffmpeg -hide_banner -list_devices true -f dshow -i dummy 2>&1 | ForEach-Object { "$_" }
  foreach ($k in @(@('video', 'Kamera'), @('audio', 'Mic'))) {
    Write-Host "$($k[1]) di PC ini:"
    $dev | Where-Object { $_ -match "\($($k[0])\)$" } | ForEach-Object { '  ' + ($_ -replace '^.*\] ', '' -replace " \($($k[0])\)$", '') }
  }
  exit
}
if (-not $Name -and -not $Pin) { throw 'Isi -Pin (dari operator) atau -Name, atau -List untuk melihat kamera' }

# first encoder that opens on this PC wins: NVIDIA, AMD, Intel, then software
$encoders = [ordered]@{
  h264_nvenc = @('-preset', 'p4', '-tune', 'll', '-profile:v', 'baseline')
  h264_amf   = @('-usage', 'lowlatency', '-profile:v', 'constrained_baseline')   # ultralowlatency fails on older AMD (RX 580)
  h264_qsv   = @('-preset', 'veryfast', '-profile:v', 'baseline')
  libx264    = @('-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'baseline')
}
$enc = $null
foreach ($e in $encoders.Keys) {
  & ffmpeg -hide_banner -loglevel error -f lavfi -i "color=black:s=${Size}:r=${Fps}" -frames:v 1 -pix_fmt nv12 -c:v $e @($encoders[$e]) -f null - 2>$null
  if ($LASTEXITCODE -eq 0) { $enc = $e; break }
}
if (-not $enc) { throw 'Tidak ada encoder H.264 yang bisa dibuka' }
Write-Host "Encoder: $enc ($(if ($enc -eq 'libx264') { 'software / CPU' } else { 'GPU' }))   Mic: $(if ($Mic) { $Mic } else { 'tidak ada' })"

if ($Camera -eq 'test') {
  # test pattern; with -Mic test the picture flashes white while a beep plays, every 2 s (A/V sync check)
  $src = @('-re', '-f', 'lavfi', '-i', "testsrc2=s=${Size}:r=${Fps},drawbox=c=white:t=fill:enable='lt(mod(t,2),0.1)'")
  if ($Mic -eq 'test') { $src += @('-re', '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,2),0.1),0.5*sin(2*PI*1000*t),0)':s=48000") }
} else {
  # one dshow input for camera and mic keeps their timestamps on the same clock
  $dev = "video=$Camera" + $(if ($Mic) { ":audio=$Mic" } else { '' })
  # 20 ms mic chunks: with the default (~0.5 s) the muxer sends video and sound in bursts and ~70% of the
  # packets never reached the bridge
  $src = @('-f', 'dshow', '-rtbufsize', '256M', '-audio_buffer_size', '20', '-vcodec', 'mjpeg', '-video_size', $Size, '-framerate', "$Fps", '-i', $dev)
}
# @(...) around the if: a one-item result (-an) would otherwise be a plain string, and splatting it sends '-' 'a' 'n'
$audio = @(if ($Mic) { '-c:a', 'libopus', '-b:a', '64k', '-ar', '48000', '-ac', '2', '-application', 'lowdelay' } else { '-an' })
# A 1080p keyframe leaves as one burst; when it is too big, packets are lost before the bridge. Every encoder
# gets the same cap: no frame larger than 4x the average frame (only keyframes reach it).
$capKbit = [int]($Kbps * 4 / $Fps)
$rate = @('-b:v', "${Kbps}k", '-maxrate', "${Kbps}k", '-bufsize', "${capKbit}k")   # NVIDIA, Intel, x264: the VBV buffer is the cap
if ($enc -ne 'libx264') { $rate = @('-rc', 'cbr') + $rate }
if ($enc -eq 'h264_nvenc') { $rate += @('-zerolatency', '1') }
# AMD ignores the buffer size on keyframes, so it gets a hard per-frame limit instead
if ($enc -eq 'h264_amf') { $rate = @('-rc', 'cbr', '-b:v', "${Kbps}k", '-maxrate', "${Kbps}k", '-bufsize', "$($Kbps / 2)k", '-enforce_hrd', '1', '-max_au_size', "$($capKbit * 1000)") }   # in a list, "x, $a * 1000" repeats the whole list 1000x

# keyframe every 2 s: a viewer (or the delay buffer after a lost packet) never waits longer than that
# with a PIN the studio knows who this is, so the name never travels (kanji / emoji names broke the ffmpeg call)
$url = if ($Pin) { "$Bridge/whip/cam?pin=$Pin" } else { "$Bridge/whip/$([uri]::EscapeDataString($Name))" }
while ($true) {
  & ffmpeg -hide_banner -loglevel warning @src @audio -pix_fmt nv12 '-c:v' $enc @($encoders[$enc]) @rate -g ($Fps * 2) -bf 0 -ts_buffer_size 1048576 -f whip $url   # 1 MB UDP buffer: a 1080p keyframe burst otherwise fails with "UDP send blocked" and ends the sender
  Write-Host 'Koneksi putus, sambung ulang dalam 3 detik...'
  Start-Sleep -Seconds 3
}
