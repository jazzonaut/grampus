@echo off
rem Explicit development launcher; avoid shadowing installed grampus on PATH.
cd /d "%~dp0"
call npm run ui
if errorlevel 1 pause
