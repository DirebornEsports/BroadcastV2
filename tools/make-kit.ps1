# Builds dist\direborn-cam-lan-test.zip: everything a venue needs for the LAN cam test, no Rust or npm there.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$kit = Join-Path $root 'dist\direborn-cam-lan-test'
& "$env:USERPROFILE\.cargo\bin\cargo.exe" build --release --manifest-path "$root\studio\Cargo.toml"
if ($LASTEXITCODE) { throw 'cargo build gagal' }
if (-not (Test-Path "$root\node_modules\werift")) { Push-Location $root; npm install --no-audit --no-fund; Pop-Location }

Remove-Item $kit -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$kit\studio", "$kit\bridge", "$kit\pemain" | Out-Null
Copy-Item "$root\studio\target\release\studio-recv.exe", "$root\studio\start-cams.ps1", "$root\studio\start-cams.bat" "$kit\studio"
Copy-Item "$root\bridge\server.mjs", "$root\bridge\localsfu.mjs", "$root\package.json" "$kit\bridge"
Copy-Item "$root\node_modules" "$kit\bridge\node_modules" -Recurse
Copy-Item "$root\sender\kirim.ps1", "$root\sender\kirim.bat" "$kit\pemain"
Copy-Item "$root\docs\PANDUAN-TES-LAN.md" "$kit\PANDUAN.md"

$zip = "$kit.zip"; Remove-Item $zip -ErrorAction SilentlyContinue
Compress-Archive "$kit\*" $zip
"{0} ({1:N1} MB)" -f $zip, ((Get-Item $zip).Length / 1MB)
