@echo off
rem Double-click: starts the bridge (if not running) and one delayed receiver per player.
rem Edit the names below, or: start-cams.bat -Names Dreamocel,woMy -Delay 900
cd /d "%~dp0"
netstat -ano | findstr /r /c:":8787 .*LISTENING" >nul || start "Direborn bridge" /min cmd /c "cd /d ..\bridge && node server.mjs"
if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File start-cams.ps1 -Names Dreamocel,woMy,PotaT2,db-,dalul -Delay 10
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File start-cams.ps1 %*
)
