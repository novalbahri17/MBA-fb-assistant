@echo off
echo ==========================================
echo   🚀 Facebook Auto Poster Launcher
echo ==========================================
echo.
echo Memulai server...
echo.
cd /d "%~dp0"
start "FB Auto Poster Server" cmd /k "node server-v2.js"
echo.
echo Tunggu 3 detik...
timeout /t 3 /nobreak >nul
echo.
echo Membuka browser...
start http://localhost:8080
echo.
echo ==========================================
echo Server berjalan di: http://localhost:8080
echo Jangan tutup window server!
echo ==========================================
pause