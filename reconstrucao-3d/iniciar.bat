@echo off
title Reconstrucao 3D
cd /d "%~dp0"
echo.
if not exist ".venv\Scripts\python.exe" (
  echo  Criando o ambiente Python na primeira vez...
  python -m venv .venv || goto :erro
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :erro
)
set ADB=%LOCALAPPDATA%\Android\platform-tools\adb.exe
if exist "%ADB%" (
  "%ADB%" reverse tcp:8000 tcp:8000 >nul 2>&1 && echo  Celular ligado: abra http://localhost:8000/captura no Chrome dele. || echo  Celular nao encontrado no cabo (o visualizador funciona assim mesmo).
)
echo  Visualizador: http://localhost:8000
echo.
".venv\Scripts\python.exe" -m backend.servidor
pause
exit /b

:erro
echo  Nao deu para preparar o ambiente Python.
pause
