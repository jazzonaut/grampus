@echo off
setlocal DisableDelayedExpansion
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Grampus requires Node.js 24 or later on PATH. Install it and try again.
  if "%~1"=="" pause
  exit /b 1
)
node "%~dp0scripts\install.mjs" %*
set "GRAMPUS_INSTALL_EXIT=%errorlevel%"
if "%~1"=="" pause
exit /b %GRAMPUS_INSTALL_EXIT%
