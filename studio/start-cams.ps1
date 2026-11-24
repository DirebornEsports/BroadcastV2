# Direborn Studio (prototype): one delayed receiver per player cam, all sharing one delay.
#   .\start-cams.ps1 -Names Dreamocel,woMy,PotaT2,db-,dalul -Delay 900
# OBS: Media Source per cam, Local File off, Input udp://127.0.0.1:<port>, hardware decoding on.
param(
  [Parameter(Mandatory)][string[]]$Names,
  [double]$Delay = 10,
  [string]$Bridge = 'http://127.0.0.1:8787',
  [int]$FirstPort = 5000
)
$ErrorActionPreference = 'Stop'
# powershell -File (the .bat) passes "a,b,c" as one string, not a list
$Names = @($Names -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$exe = @("$PSScriptRoot\studio-recv.exe", "$PSScriptRoot\target\release\studio-recv.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { throw 'studio-recv.exe tidak ditemukan' }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { throw 'ffmpeg belum terpasang (winget install Gyan.FFmpeg)' }

# receivers left over from a studio window closed with X (not q) would pull the same cams twice and
# send to the same OBS ports
$old = @(Get-CimInstance Win32_Process -Filter "Name like 'studio-recv%'" | Where-Object { $_.ExecutablePath -like "$(Split-Path (Resolve-Path $exe).Path)\studio-recv*.exe" })
if ($old) { Write-Host "Menutup $($old.Count) receiver lama..."; $old | ForEach-Object { & taskkill /PID $_.ProcessId /T /F | Out-Null } }

$logs = Join-Path $PSScriptRoot 'logs'; New-Item -ItemType Directory -Force $logs | Out-Null
$delayFile = Join-Path $logs 'delay.txt'
Set-Content $delayFile $Delay -Encoding ascii

$cams = @(); $i = 0
foreach ($n in $Names) {
  $port = $FirstPort + $i; $i++
  $p = Start-Process $exe -PassThru -WindowStyle Hidden -ArgumentList '--bridge', $Bridge, '--name', "`"$n`"", '--delay', $Delay, '--delay-file', "`"$delayFile`"", '--out', "udp://127.0.0.1:${port}?pkt_size=1316" `
    -RedirectStandardOutput "$logs\$n.status.log" -RedirectStandardError "$logs\$n.log"
  $cams += [pscustomobject]@{ Name = $n; Port = $port; Proc = $p }
}

function Show-Status {
  Clear-Host
  Write-Host "DIREBORN STUDIO - delay $(Get-Content $delayFile) detik   (bridge $Bridge)`n"
  $fromPlayer = @{}; try { Invoke-RestMethod "$Bridge/cams" -TimeoutSec 2 | ForEach-Object { $fromPlayer[$_.name.ToLower()] = $_.lostFromPlayer } } catch {}
  foreach ($c in $cams) {
    $s = Get-Content "$logs\$($c.Name).status.log" -Tail 1 -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
    $state = if ($c.Proc.HasExited) { 'MATI (lihat logs)' } elseif (-not $s -or -not $s.connected) { 'menunggu cam...' } else { 'LIVE  {0,5:N0} kbps {1,4:N0} fps  buffer {2,6:N1} s  hilang {3} (dari pemain {4})' -f $s.kbps, $s.fps, $s.buffered, $s.lost, $fromPlayer[$c.Name.ToLower()] }
    Write-Host ('{0,-12} udp://127.0.0.1:{1}   {2}' -f $c.Name, $c.Port, $state)
  }
  Write-Host "`nKetik angka = delay baru (mis. 900), +0.5 / -0.5 = geser sedikit, Enter = refresh, q = stop semua"
}

try {
  while ($true) {
    Show-Status
    $cmd = (Read-Host '>').Trim()
    if ($cmd -eq 'q') { break }
    $cur = [double](Get-Content $delayFile)
    $new = if ($cmd -match '^[+-]\d+(\.\d+)?$') { $cur + [double]$cmd } elseif ($cmd -match '^\d+(\.\d+)?$') { [double]$cmd } else { $null }
    if ($null -ne $new) { Set-Content $delayFile ([math]::Min([math]::Max($new, 0), 1020)) -Encoding ascii }
  }
} finally {
  # the receivers' ffmpeg children go too
  foreach ($c in $cams) { if (-not $c.Proc.HasExited) { & taskkill /PID $c.Proc.Id /T /F | Out-Null } }
}
