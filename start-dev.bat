@echo off
setlocal

set "NODE_HOME=%LOCALAPPDATA%\nodejs\node-v22.14.0-win-x64"
set "NODE_EXE=%NODE_HOME%\node.exe"
set "NPM_CLI=%NODE_HOME%\node_modules\npm\bin\npm-cli.js"

if not exist "%NODE_EXE%" (
  echo [error] Node 22 not found: %NODE_EXE%
  echo Please install Node 22 or update NODE_HOME in this script.
  pause
  exit /b 1
)

if not exist "%NPM_CLI%" (
  echo [error] npm CLI not found: %NPM_CLI%
  pause
  exit /b 1
)

set "PATH=%NODE_HOME%;%PATH%"
cd /d "%~dp0"

echo [info] Using:
"%NODE_EXE%" -v
echo [info] Starting qual-match dev server...

"%NODE_EXE%" "%NPM_CLI%" run dev

pause
