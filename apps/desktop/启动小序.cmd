@echo off
setlocal
cd /d "%~dp0"
set "framework=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319"
if not exist "%framework%\csc.exe" set "framework=%WINDIR%\Microsoft.NET\Framework\v4.0.30319"
if not exist "%framework%\csc.exe" goto missing
"%framework%\csc.exe" /nologo /target:winexe /platform:anycpu /optimize+ /win32manifest:app.manifest /out:XutiDesktop.exe /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll /reference:System.Security.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:"%framework%\WPF\WindowsBase.dll" /reference:"%framework%\WPF\UIAutomationClient.dll" /reference:"%framework%\WPF\UIAutomationTypes.dll" XutiDesktop.cs
if errorlevel 1 goto failed
start "" "%~dp0XutiDesktop.exe"
exit /b 0
:missing
echo Microsoft .NET Framework 4.8 is required. Install it from Microsoft, then retry.
:failed
echo Build failed. Keep this window open and contact your administrator.
pause
exit /b 1
