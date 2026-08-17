@echo off
setlocal
set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"
if exist "%ELECTRON_EXE%" (
  start "" "%ELECTRON_EXE%" "%~dp0"
  exit /b 0
)
echo Electron is not installed. Run setup.cmd first.
pause
exit /b 1
