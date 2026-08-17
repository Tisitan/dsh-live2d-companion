@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\node_modules\electron\dist\electron.exe" "%~dp0codex-hook.cjs"
