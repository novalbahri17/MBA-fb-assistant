# Facebook Auto Poster Dashboard Launcher
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "   🚀 Facebook Auto Poster Dashboard" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Node.js tidak ditemukan! Install dulu dari https://nodejs.org" -ForegroundColor Red
    pause
    exit
}

# Go to web-dashboard directory
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location "$scriptPath\web-dashboard"

# Install dependencies if needed
if (!(Test-Path "node_modules")) {
    Write-Host "📦 Menginstall dependensi..." -ForegroundColor Yellow
    npm install
}

Write-Host "🔥 Memulai server..." -ForegroundColor Green
Write-Host "📱 Buka http://localhost:8080 di browser" -ForegroundColor Green
Write-Host "⏳ Tunggu 3 detik..." -ForegroundColor Gray
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan

# Start server
node server.js