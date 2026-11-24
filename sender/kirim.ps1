# Direborn Cam sender (2.0 prototype): webcam -> GPU H.264 -> WHIP bridge.
# The Tauri app will run the same ffmpeg command; this script is the stand-in until then.
#   .\sender\kirim.ps1 -Name Dreamocel -Camera "OsmoPocket4"
#   .\sender\kirim.ps1 -Name Test -Camera test          (test pattern, no camera)
param(
  [Parameter(Mandatory)][string]$Name,
  [string]$Camera = 'test',
  [string]$Bridge = 'http://127.0.0.1:8787',
  [int]$Kbps = 4500,
  [string]$Size = '1920x1080',
  [int]$Fps = 30
)

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
Write-Host "Encoder: $enc ($(if ($enc -eq 'libx264') { 'software / CPU' } else { 'GPU' }))"

$input = if ($Camera -eq 'test') { @('-re', '-f', 'lavfi', '-i', "testsrc2=s=${Size}:r=${Fps}") }
         else { @('-f', 'dshow', '-rtbufsize', '256M', '-vcodec', 'mjpeg', '-video_size', $Size, '-framerate', "$Fps", '-i', "video=$Camera") }
$rate = @('-rc', 'cbr', '-b:v', "${Kbps}k", '-maxrate', "${Kbps}k", '-bufsize', "$($Kbps / 2)k")
if ($enc -eq 'libx264') { $rate = @('-b:v', "${Kbps}k", '-maxrate', "${Kbps}k", '-bufsize', "$($Kbps / 2)k") }

# keyframe every 2 s: a viewer (or the delay buffer after a lost packet) never waits longer than that
$url = "$Bridge/whip/$([uri]::EscapeDataString($Name))"
while ($true) {
  & ffmpeg -hide_banner -loglevel warning @input -an -pix_fmt nv12 -c:v $enc @($encoders[$enc]) @rate -g ($Fps * 2) -bf 0 -ts_buffer_size 1048576 -f whip $url   # 1 MB UDP buffer: a 1080p keyframe burst otherwise fails with "UDP send blocked" and ends the sender
  Write-Host 'Koneksi putus, sambung ulang dalam 3 detik...'
  Start-Sleep -Seconds 3
}
