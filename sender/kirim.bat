@echo off
rem Double-click: lists cameras and mics, asks for the player name, camera, mic and studio PC.
rem Or: kirim.bat -Name Dreamocel -Camera "OsmoPocket4" -Bridge http://192.168.1.10:8787
cd /d "%~dp0"
if not "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File kirim.ps1 %*
  pause
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File kirim.ps1 -List
set /p NAME=Nama pemain:
set /p CAM=Nama kamera (persis seperti di daftar):
set MIC=
set /p MIC=Nama mic (persis seperti di daftar, kosongkan kalau tanpa suara):
set /p STUDIO=IP PC studio (mis. 192.168.1.10):
powershell -NoProfile -ExecutionPolicy Bypass -File kirim.ps1 -Name "%NAME%" -Camera "%CAM%" -Mic "%MIC%" -Bridge "http://%STUDIO%:8787"
pause
