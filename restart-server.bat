@echo off
chcp 65001 > nul

echo [🔄] Reiniciando servidor...
echo.

echo [🛑] Matando processos Node antigos...
taskkill /IM node.exe /F > nul 2>&1
timeout /t 2 /nobreak > nul

echo [🚀] Iniciando servidor (porta automática)...
node server.js

pause