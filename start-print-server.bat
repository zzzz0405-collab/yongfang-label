@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 永芳標籤 — 印表機狀態 API

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [錯誤] 找不到 Node.js，請先安裝：https://nodejs.org/
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\express" (
    echo 正在安裝相依套件...
    call npm install
    if errorlevel 1 (
        echo npm install 失敗
        pause
        exit /b 1
    )
)

echo 啟動印表機狀態 API（關閉此視窗即停止檢測）...
node print-server.js
pause
