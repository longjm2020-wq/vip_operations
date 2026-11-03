@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0XutiDesktop.exe" goto missing
start "" "%~dp0XutiDesktop.exe"
exit /b 0
:missing
echo Extract the full ZIP archive before starting XutiDesktop.exe.
pause
exit /b 1
