@echo off
title FB Auto Poster Pro - Server
color 0A
cls

echo.
echo  ================================================
echo   🚀 FB AUTO POSTER PRO - DASHBOARD
echo  ================================================
echo.

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo  ❌ Node.js tidak ditemukan!
    echo  📥 Install dari: https://nodejs.org
    pause
    exit /b
)

echo  ✅ Node.js terdeteksi
echo.

:: Go to directory
cd /d "%~dp0\web-dashboard"

:: Check node_modules
if not exist "node_modules" (
    echo  📦 Menginstall dependensi...
    call npm install
    if errorlevel 1 (
        echo  ❌ Gagal install dependensi
        pause
        exit /b
    )
    echo  ✅ Dependensi terinstall
    echo.
)

echo  🔥 Memulai server...
echo  📱 Buka browser: http://localhost:8080
echo  ⏳ Tunggu 3 detik...
echo.
timeout /t 3 /nobreak >nul

:: Start browser in background
start "" http://localhost:8080

echo  ================================================
echo   Server berjalan! Jangan tutup window ini.
echo  ================================================
echo.

:: Run server
node server.js

:: If server stops
echo.
echo  ⚠️  Server berhenti!
pause