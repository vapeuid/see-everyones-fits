@echo off
cd /d "%~dp0"
if exist "node\node.exe" ( "node\node.exe" app.js sync ) else ( node app.js sync )
pause
