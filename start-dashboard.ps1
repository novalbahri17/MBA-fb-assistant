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

# Go to project directory
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptPath

# Check server-v2.js exists
if (!(Test-Path "server-v2.js")) {
    Write-Host "❌ server-v2.js tidak ditemukan!" -ForegroundColor Red
    pause
    exit
}

Write-Host "🔥 Memulai server..." -ForegroundColor Green
Write-Host "📱 Buka http://localhost:8080 di browser" -ForegroundColor Green
Write-Host "⏳ Tunggu 3 detik..." -ForegroundColor Gray
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan

# Start server
node server-v2.js