@echo off
rem Opens See Everyone's Fits in its own window. The app keeps running in a minimized window in the taskbar and
rem quits about two minutes after you close the app window.
cd /d "%~dp0"
if exist "node\node.exe" (
  start "See Everyone's Fits" /min "node\node.exe" app.js window
) else (
  start "See Everyone's Fits" /min node app.js window
)
