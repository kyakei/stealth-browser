#!/usr/bin/env bash
# stealth-browser-v2 launcher — pins Chromium to a known Xvfb display so
# x11vnc can attach when the AI calls /v2/display/show.
#
# Without this, xvfb-run picks a random display and we'd need to discover it
# each time. Fixed display = stable noVNC URL.

set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-99}"
DISPLAY=":${DISPLAY_NUM}"
SCREEN="${SCREEN_SIZE:-1366x768x24}"
PIDFILE="/tmp/stealth-browser-v2-xvfb-${DISPLAY_NUM}.pid"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

# Kill any prior Xvfb we owned on this display, ignore if absent.
if [[ -f "$PIDFILE" ]]; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
fi
# And any stray x11vnc / websockify from a prior session.
pkill -f "x11vnc.*-display\\s*${DISPLAY}" 2>/dev/null || true
pkill -f "websockify.*6080" 2>/dev/null || true

# Start Xvfb in background on the fixed display.
# -ac disables X access control — fine because DISPLAY is localhost-only.
Xvfb "$DISPLAY" -screen 0 "$SCREEN" -ac -nolisten tcp &>"/tmp/stealth-browser-v2-xvfb.log" &
XVFB_PID=$!
echo "$XVFB_PID" > "$PIDFILE"

# Wait for the X server to be ready.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if DISPLAY="$DISPLAY" xdpyinfo >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

export DISPLAY
export STEALTH_V2_DISPLAY="$DISPLAY"

# Clipboard sync between the VNC client and the Xvfb display.
# autocutsel mirrors CUTBUFFER0 <-> CLIPBOARD, a second copy handles PRIMARY.
# Without these, "copy from inside Chromium" doesn't reach the noVNC clipboard
# panel (and paste the other way also breaks).
if command -v autocutsel >/dev/null 2>&1; then
  pkill -f "autocutsel.*$DISPLAY" 2>/dev/null || true
  DISPLAY="$DISPLAY" autocutsel -fork -selection CLIPBOARD >/dev/null 2>&1 || true
  DISPLAY="$DISPLAY" autocutsel -fork -selection PRIMARY   >/dev/null 2>&1 || true
fi

cd "$PROJECT_DIR"
exec node dist/index.js "$@"
