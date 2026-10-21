@echo off
setlocal
cd /d "%~dp0"

set "REHEARSAL_NODE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined REHEARSAL_NODE set "REHEARSAL_NODE=%%N"
if not defined REHEARSAL_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "REHEARSAL_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not defined REHEARSAL_NODE (
  echo Dress Rehearsal needs Node.js 22 or newer.
  echo Install Node.js from https://nodejs.org and open this launcher again.
  pause
  exit /b 1
)

"%REHEARSAL_NODE%" -e "if(Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if errorlevel 1 (
  echo Dress Rehearsal needs Node.js 22 or newer.
  echo Update Node.js and open this launcher again.
  pause
  exit /b 1
)

echo Dress Rehearsal is starting in your browser.
echo Keep this window open. Press Ctrl+C to stop the app.
"%REHEARSAL_NODE%" preview.mjs --open
if errorlevel 1 (
  echo.
  echo The app could not start. Read the message above for details.
  pause
)
endlocal
