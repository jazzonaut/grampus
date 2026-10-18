@echo off
cd /d "%~dp0"
call npm run ui
if errorlevel 1 pause
