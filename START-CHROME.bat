@echo off
title FB Auto Poster - Chrome Launcher
color 0A
cls

echo ==========================================
echo   🚀 FB Auto Poster - Chrome Launcher
echo ==========================================
echo.
echo ⚠️  PENTING: Tutup SEMUA Chrome/Edge dulu!
echo.
pause

echo.
echo 🔥 Menjalankan Chrome dengan remote debugging...
echo.
echo Setelah Chrome terbuka:
echo 1. Login ke Facebook (kalau belum)
echo 2. Biarkan Chrome tetap terbuka
echo 3. Jalankan FB Auto Poster dari dashboard
echo.

start chrome.exe --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\Google\Chrome\User Data" https://facebook.com

echo.
echo ✅ Chrome berjalan di port 9222
echo ⏳ Tunggu Chrome terbuka...
echo.
timeout /t 5 >nul

:check
cls
echo ==========================================
echo   🚀 FB Auto Poster - Chrome Launcher
echo ==========================================
echo.
echo Status: Chrome sedang berjalan
echo.
echo Pastikan Anda sudah LOGIN ke Facebook
echo.
echo Pilihan:
echo [1] ✅ Sudah login, lanjut ke dashboard
echo [2] 🔄 Cek ulang status
echo [3] ❌ Tutup Chrome dan keluar
echo.
set /p choice="Pilih [1-3]: "

if "%choice%"=="1" goto dashboard
if "%choice%"=="2" goto check
if "%choice%"=="3" goto exit
goto check

:dashboard
echo.
echo Membuka dashboard...
start http://localhost:8080
goto check

:exit
echo.
echo Menutup Chrome...
taskkill /F /IM chrome.exe >nul 2>&1
echo ✅ Selesai!
pause
exit
