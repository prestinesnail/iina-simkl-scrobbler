#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

FILES=(
  Info.json
  LICENSE
  README.md
  introdb.js
  main.js
  media.js
  overlay.html
  overlayCard.js
  preferences.html
  session.js
  sidebar.html
  simkl.js
)

VERSION="$(python3 -c 'import json; print(json.load(open("Info.json"))["version"])')"
OUT="iina-simkl-scrobbler-${VERSION}.iinaplgz"

for file in "${FILES[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "missing package file: $file" >&2
    exit 1
  fi
done

rm -f "$OUT"
zip -X -q "$OUT" "${FILES[@]}"
echo "Wrote $OUT ($(unzip -Z -1 "$OUT" | wc -l | tr -d ' ') files)"
unzip -Z -1 "$OUT"
