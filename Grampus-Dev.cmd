@echo off
rem Explicit development launcher; avoid shadowing installed grampus on PATH.
cd /d "%~dp0"
rem The dashboard client in web\ has its own dependencies; install them once.
if not exist web\node_modules call npm --prefix web ci
if errorlevel 1 goto failed
call npm run ui
if errorlevel 1 goto failed
exit /b 0
:failed
pause
