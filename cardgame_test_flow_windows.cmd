@echo off
REM cardgame_test_flow_windows.cmd
REM Amaç: ENV verip cardgame_test_flow.js çalıştırmak.

set HOST=127.0.0.1
set HTTP_PORT=3000
set WS_PORT=3001

REM Login (sunucu u/p bekliyor)
set TEST_U=ali
set TEST_P=123

REM İstersen sabit masa:
REM set TABLE_ID=1

cd /d C:\xampp\htdocs\cardgame
node cardgame_test_flow.js
pause
