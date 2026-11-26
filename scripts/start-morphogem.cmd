@echo off
setlocal
cd /d "%~dp0.."
echo Starting MorphoGem Web Server on http://127.0.0.1:8766 ...
node server.mjs
