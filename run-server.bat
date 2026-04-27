@echo off
chcp 65001 > nul

REM Instalar dependências se necessário
if not exist "node_modules" (
    echo [*] Instalando dependências...
    npm install
)

REM Iniciar servidor (porta automática)
start cmd /k "npm start"

REM Fechar esta janela automaticamente
exit
