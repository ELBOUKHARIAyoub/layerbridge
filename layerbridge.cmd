@echo off
rem Double-click to start LayerBridge. Run "layerbridge.cmd setup" once to install the plugins.
cd /d "%~dp0"
if not exist node_modules call npm install --no-audit --no-fund
if "%~1"=="" (node layerbridge.mjs start --figcraft --open) else (node layerbridge.mjs %*)
pause
