@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 18 or later, then run this file again.
  pause
  exit /b 1
)
call npm.cmd install
if errorlevel 1 (
  echo.
  echo Installation failed. Check the network connection and the messages above.
  pause
  exit /b 1
)
echo.
echo Setup complete. You can now run start.cmd.
pause
