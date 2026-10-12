@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if exist ".runtime\node.exe" set "PATH=%CD%\.runtime;%PATH%"
set "SP_COMBAT=client"
set "SP_VERIFY=off"
set "TRUST_PROXY=auto"
call scripts\start-windows.bat --port 3000 --host 127.0.0.1 %*
exit /b %ERRORLEVEL%
