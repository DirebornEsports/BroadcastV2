# Cadangan: hanya dipakai kalau Dota tidak mau mengirim GSI langsung ke alamat https:// server online.
# Script ini menerima GSI dari Dota di PC ini (http://127.0.0.1:3000/) lalu meneruskannya ke server online.
# Pakai:  klik kanan → Run with PowerShell   (biarkan jendelanya terbuka selama siaran)
# Lalu di file .cfg Dota ganti uri menjadi:  "uri" "http://127.0.0.1:3000/"
param(
  [string]$Target = "https://GANTI-DENGAN-ALAMAT-WORKER/gsi",
  [int]$Port = 3000
)
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "Relay GSI aktif: Dota -> http://127.0.0.1:$Port/ -> $Target" -ForegroundColor Green
Write-Host "Tutup jendela ini untuk berhenti."
$count = 0
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $reader = New-Object System.IO.StreamReader($ctx.Request.InputStream, [System.Text.Encoding]::UTF8)
    $body = $reader.ReadToEnd()
    $r = Invoke-WebRequest -Uri $Target -Method Post -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -ContentType "application/json" -UseBasicParsing -TimeoutSec 5
    $ctx.Response.StatusCode = [int]$r.StatusCode
    $count++
    if ($count % 50 -eq 1) { Write-Host ("{0:HH:mm:ss}  {1} pesan diteruskan" -f (Get-Date), $count) }
  } catch {
    $ctx.Response.StatusCode = 502
    Write-Host ("{0:HH:mm:ss}  gagal meneruskan: {1}" -f (Get-Date), $_.Exception.Message) -ForegroundColor Yellow
  } finally {
    $ctx.Response.Close()
  }
}
