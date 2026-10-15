@echo off
cd /d "%~dp0"
title See Everyone's Fits
if exist "node\node.exe" ( "node\node.exe" app.js ) else ( node app.js )
pause
