# Builds the Direborn Studio installer (NSIS).
#   powershell -ExecutionPolicy Bypass -File tools\build-studio.ps1
# 1. hub manifest (hub\src\generated)  2. stage studio-app\res\ (hub, bridge + werift, studio-recv.exe)  3. npx tauri build
# Output: studio-app\src-tauri\target\release\bundle\nsis\Direborn Studio_<version>_x64-setup.exe
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$app = Join-Path $repo 'studio-app'
$res = Join-Path $app 'res'
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"

function Copy-Tree($from, $to, [string[]]$extra = @()) {
  # robocopy: exit codes below 8 mean success
  robocopy $from $to /E /NFL /NDL /NJH /NJS /NP @extra | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $from -> $to failed ($LASTEXITCODE)" }
  $global:LASTEXITCODE = 0
}

Write-Host '== hub manifest'
Push-Location (Join-Path $repo 'hub')
node tools/build-manifest.mjs
if ($LASTEXITCODE) { throw 'build-manifest failed' }
Pop-Location

$recv = Join-Path $repo 'studio\target\release\studio-recv.exe'
if (-not (Test-Path $recv)) { throw "studio-recv.exe missing: build studio\ first (cargo build --release)" }

Write-Host "== staging $res"
if (Test-Path $res) { Remove-Item $res -Recurse -Force }
$hub = Join-Path $repo 'hub'
foreach ($d in 'src', 'lib', 'public', 'seed', 'tools', 'node_modules') { Copy-Tree (Join-Path $hub $d) (Join-Path $res "hub\$d") }
# dev\: local.mjs + localsfu.mjs + dev.example.json; never the operator's secrets or test data
Copy-Tree (Join-Path $hub 'dev') (Join-Path $res 'hub\dev') @('/XD', '.data', '/XF', '.dev.json', 'dev.json')
Copy-Item (Join-Path $hub 'config.json'), (Join-Path $hub 'package.json') (Join-Path $res 'hub')
if (-not (Test-Path (Join-Path $res 'hub\src\generated\manifest.json'))) { throw 'hub\src\generated\manifest.json missing' }

New-Item -ItemType Directory (Join-Path $res 'bridge') | Out-Null
Copy-Item (Join-Path $repo 'bridge\*.mjs'), (Join-Path $repo 'bridge\dashboard.html') (Join-Path $res 'bridge')
Copy-Tree (Join-Path $repo 'node_modules') (Join-Path $res 'bridge\node_modules')   # werift for localsfu.mjs
if (-not (Test-Path (Join-Path $res 'bridge\node_modules\werift'))) { throw 'werift missing: run npm install in the repo root' }
Copy-Item $recv $res

Write-Host '== tauri build'
Push-Location $app
if (-not (Test-Path 'node_modules\@tauri-apps\cli')) { npm install; if ($LASTEXITCODE) { throw 'npm install failed' } }
npx tauri build --config src-tauri/tauri.bundle.json
if ($LASTEXITCODE) { throw 'tauri build failed' }
Pop-Location

$exe = Get-ChildItem (Join-Path $app 'src-tauri\target\release\bundle\nsis\*-setup.exe') | Sort-Object LastWriteTime | Select-Object -Last 1
Write-Host ("== installer: {0} ({1:N0} MB)" -f $exe.FullName, ($exe.Length / 1MB))
