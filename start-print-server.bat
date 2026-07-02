@echo off
cd /d "%~dp0"
title Yongfang Label Print Server

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [ERROR] Node.js not found. Install from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\express" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
)

echo.
echo Stopping old print-server processes...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*print-server.js*' } | ForEach-Object { Write-Host ('  kill node PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :3847 ^| findstr LISTENING') do (
    echo   kill port 3847 PID %%p
    taskkill /F /PID %%p >nul 2>&1
)
timeout /t 2 /nobreak >nul

echo.
echo ========================================
echo   Yongfang Label - Print API Server
echo ========================================
echo   Open in browser:
echo   http://localhost:3847
echo.
echo   Health check:
echo   http://localhost:3847/api/health
echo.
echo   Server rev 3 (image print API)
echo   Keep this window open for API print.
echo ========================================
echo.

node print-server.js
if errorlevel 1 (
    echo.
    echo [FAILED] Could not start. Port 3847 may still be in use.
    echo Close other print-server windows and run this bat again.
    echo.
)
pause
