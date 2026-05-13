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

# pygbag recursively packs every file under the project dir into the .apk.
# Build the venv OUTSIDE the project root so its ~10k vendored files don't
# end up bundled. Same reason we drop node_modules and the Audio Engine
# source tree below — the only artefacts pygbag should see are main.py and
# the compiled assets/.
PYGBAG_VENV=/tmp/pygbag-venv
python3 -m venv "$PYGBAG_VENV"
"$PYGBAG_VENV/bin/python" -m pip install --upgrade pip
"$PYGBAG_VENV/bin/python" -m pip install 'pygbag>=0.9.0'

rm -rf "Audio Engine"   # only assets/audio_manager.js is needed at runtime
rm -rf .vercel          # Vercel build metadata

# Build the WASM bundle
"$PYGBAG_VENV/bin/python" -m pygbag --build main.py

# Copy static assets into build/web/ so the browser can fetch them via HTTP.
# Use `if` (which `set -e` ignores) so unmatched globs don't abort the script.
mkdir -p build/web/assets
for f in assets/audio_manager.js assets/*.ogg assets/*.mp3 assets/*.wav assets/*.flac; do
  if [ -f "$f" ]; then
    cp "$f" build/web/assets/
  fi
done
