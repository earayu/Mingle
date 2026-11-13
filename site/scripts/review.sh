#!/bin/sh
# Screenshots the built site (site/dist) at desktop and phone widths, light and dark, into .site-review/.
set -eu
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT=8931
mkdir -p .site-review
python3 -m http.server "$PORT" -d site/dist >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER' EXIT
sleep 1
for spec in "en:/:1440:light" "zh:/zh/:1440:dark" "en-m:/:520:light" "zh-m:/zh/:520:dark"; do
  IFS=: read -r n p w th <<EOS
$spec
EOS
  prof=$(mktemp -d)
  scheme=1; [ "$th" = dark ] && scheme=0
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$prof" --window-size="$w,9800" \
    --blink-settings=preferredColorScheme=$scheme --force-prefers-reduced-motion --virtual-time-budget=4000 \
    --screenshot=".site-review/$n.png" "http://127.0.0.1:$PORT$p" 2>/dev/null || true
  rm -rf "$prof"
done
