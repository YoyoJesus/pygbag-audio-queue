#!/usr/bin/env bash
set -euo pipefail

# Compile the TypeScript audio engine → assets/audio_manager.js
cd "Audio Engine"
npm ci
npx tsc --module es2020
cd ..

# Install pygbag into an isolated venv and build the WASM bundle
python3 -m venv .pygbag-venv
.pygbag-venv/bin/python -m pip install --upgrade pip
.pygbag-venv/bin/python -m pip install 'pygbag>=0.9.0'
.pygbag-venv/bin/python -m pygbag --build main.py

# Copy static assets into build/web/ so the browser can fetch them via HTTP
mkdir -p build/web/assets
for f in assets/audio_manager.js assets/*.ogg assets/*.mp3 assets/*.wav assets/*.flac; do
  [ -f "$f" ] && cp "$f" build/web/assets/
done
