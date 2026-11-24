@echo off
rem Direborn broadcast - versi offline (mode LAN). Klik dua kali untuk menyalakan server.
title Direborn broadcast - server LAN
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js belum terinstall. Download versi LTS dari https://nodejs.org lalu jalankan file ini lagi.
  pause
  exit /b 1
)

if not exist "node_modules\werift" (
  echo Menginstall paket ^(sekali saja^)...
  call npm install
  if errorlevel 1 (
    echo npm install gagal. Cek koneksi internet lalu coba lagi.
    pause
    exit /b 1
  )
)

if not exist "dev\.dev.json" (
  copy "dev\dev.example.json" "dev\.dev.json" >nul
  echo.
  echo File kunci dev\.dev.json baru dibuat dari contoh.
  echo Ganti ADMIN_PASSWORD, PUSH_KEY, VIEW_KEY dan GSI_TOKEN di file itu, lalu jalankan file ini lagi.
  notepad "dev\.dev.json"
  pause
  exit /b 1
)

echo Jangan tutup jendela ini selama event: kalau ditutup, overlay dan cam mati.
echo.
node dev\local.mjs --lan
echo.
echo Server berhenti.
pause
