@echo off
cd /d "%~dp0"
set "EXE=src-tauri\target\release\study-mode-app.exe"

if exist "%EXE%" (
    start "" "%EXE%"
    exit /b 0
)

echo.
echo  Study Mode is not built yet.
echo.
echo  Open PowerShell, go to this folder, and run:
echo    npm run tauri build
echo.
echo  The first build can take 10-15 minutes. Then use this shortcut again.
echo.
pause
