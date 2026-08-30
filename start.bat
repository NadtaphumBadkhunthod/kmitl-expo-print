@echo off
chcp 65001 >nul
cd /d "%~dp0"
title สถานีพิมพ์ PIPEK

echo.
echo   สถานีพิมพ์ผลตรวจ PIPEK - KMITL Expo
echo   ----------------------------------------
echo.

rem --------------------------------------------------------------- Node ---
rem ทุกอย่างที่เหลือรันบน Node ถ้าไม่มีให้บอกไปเลย ดีกว่าปล่อยให้ npm พังงงๆ
where node >nul 2>nul
if errorlevel 1 (
  echo   [x] เครื่องนี้ยังไม่ได้ติดตั้ง Node.js
  echo       โหลดตัว LTS จาก https://nodejs.org ติดตั้งแล้วเปิดไฟล์นี้ใหม่
  echo.
  pause
  exit /b 1
)

rem ------------------------------------------------------------ ของที่ใช้ ---
rem เช็คว่าลงครบจริงไหม ไม่ใช่แค่ว่ามีโฟลเดอร์ node_modules อยู่ - ถ้าเน็ตหลุด
rem กลางคัน โฟลเดอร์จะมีแต่ของไม่ครบ แล้วไปพังตอนสั่งพิมพ์ใบแรกหน้างานแทน
set NEED=0
if not exist "node_modules\.package-lock.json" set NEED=1
node -e "['express','puppeteer','pdf-to-printer','pngjs','qrcode','selfsigned','jsqr'].forEach(m=>require.resolve(m))" >nul 2>nul || set NEED=1

if "%NEED%"=="1" (
  echo   ติดตั้งครั้งแรก - กำลังโหลดของที่ต้องใช้ ประมาณ 150MB ครั้งเดียว
  echo   ต้องต่อเน็ตไว้ตอนนี้ ใช้เวลาสักพัก...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :installfail
  echo.
)

rem Chromium เป็นคนละก้อนกับ npm package และหายได้เองเวลาล้าง cache
rem ถ้าไม่มี ระบบจะสแกนได้แต่จัดหน้า PDF ไม่ได้ ซึ่งดูออกยากมากหน้างาน
node -e "process.exit(require('fs').existsSync(require('puppeteer').executablePath())?0:1)" >nul 2>nul
if errorlevel 1 (
  echo   ยังไม่มี Chromium สำหรับจัดหน้ารายงาน - กำลังโหลด ต้องต่อเน็ต
  echo.
  call npx --yes puppeteer browsers install chrome
  if errorlevel 1 goto :installfail
  echo.
)

rem ------------------------------------------------------------ เปิดหน้าคุม ---
rem พอร์ตอ่านจาก config.json จะได้ไม่ต้องแก้ 2 ที่เวลาย้ายพอร์ต
set PORT=8443
for /f "usebackq delims=" %%p in (`node -e "console.log(JSON.parse(require('fs').readFileSync('config.json','utf8')).port||8443)"`) do set PORT=%%p

rem รอให้ server ขึ้นจริงก่อนค่อยเปิดเบราว์เซอร์ ไม่ใช่เดาเวลาเอา - ตอนติดตั้ง
rem ครั้งแรกกว่าจะขึ้นนานกว่าปกติมาก
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -Command "for($i=0;$i -lt 120;$i++){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%PORT%);$c.Close();Start-Process ('https://localhost:%PORT%/control.html');break}catch{Start-Sleep -Milliseconds 700}}"

echo   กำลังเปิด server - หน้าควบคุมจะเด้งขึ้นมาเองเมื่อพร้อม
echo   ปิดโปรแกรม: กด Ctrl+C หรือปิดหน้าต่างนี้
echo.

node server.mjs

echo.
echo   โปรแกรมปิดแล้ว - กดปุ่มอะไรก็ได้เพื่อออก
pause >nul
exit /b 0

:installfail
echo.
echo   [x] ติดตั้งไม่สำเร็จ - อ่านข้อความข้างบน ส่วนใหญ่คือเน็ตหลุด
echo       ต่อเน็ตแล้วเปิดไฟล์นี้ใหม่อีกครั้ง
echo.
pause
exit /b 1
