#!/bin/bash
# Double-click to start LayerBridge. Run "./layerbridge.command setup" once to install the plugins.
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-audit --no-fund
if [ $# -eq 0 ]; then node layerbridge.mjs start --figcraft --open; else node layerbridge.mjs "$@"; fi
