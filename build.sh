#!/usr/bin/env bash
set -euo pipefail

# pygbag shells out to ffmpeg for audio processing; Vercel's build image
# doesn't include it, so drop a static binary onto PATH.
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Installing static ffmpeg..."
  curl -fsSL https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz -o /tmp/ffmpeg.tar.xz
  mkdir -p /tmp/ffmpeg
  tar -xf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg --strip-components=1
  export PATH="/tmp/ffmpeg/bin:$PATH"
fi
ffmpeg -version | head -1

# Compile the TypeScript audio engine → assets/audio_manager.js
cd "Audio Engine"
npm ci
npx tsc --module es2020
cd ..

# node_modules was only needed for tsc — drop it so pygbag doesn't recursively
# pack thousands of dev-dependency files into the .apk.
rm -rf "Audio Engine/node_modules"

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
