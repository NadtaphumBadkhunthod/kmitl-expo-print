@echo off
chcp 65001 >nul
cd /d "%~dp0"
title สถานีพิมพ์ PIPEK
if not exist node_modules (
  echo ติดตั้งครั้งแรก - รอสักครู่ ^(ต้องมีเน็ต^)...
  call npm install --no-audit --no-fund
)
start "" /min cmd /c "timeout /t 12 >nul && start https://localhost:8443/control.html"
node server.mjs
echo.
echo โปรแกรมปิดแล้ว - กดปุ่มใดๆ เพื่อออก
pause >nul
