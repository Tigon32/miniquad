#!/usr/bin/env bash
set -euo pipefail

probe="${MINIQUAD_FULLSCREEN_PROBE:-target/debug/examples/fullscreen_probe}"
"$probe" &
probe_pid=$!
trap 'if kill -0 "$probe_pid" 2>/dev/null; then kill "$probe_pid"; fi' EXIT

window=
for _ in {1..200}; do
  if window=$(xdotool search --onlyvisible --name "^fullscreen_probe-${probe_pid}$"); then
    break
  fi
  sleep 0.05
done
if ! [[ "$window" =~ ^[0-9]+$ ]]; then
  printf 'Probe window not found for process %s\n' "$probe_pid" >&2
  exit 1
fi

geometry() {
  xwininfo -id "$window" | awk '/Width:/{w=$2} /Height:/{h=$2} END{print w "x" h}'
}

wait_state() {
  local expected="$1"
  local size="$2"
  for _ in {1..200}; do
    state=$(xprop -id "$window" _NET_WM_STATE)
    if [[ "$(geometry)" == "$size" ]]; then
      if [[ "$expected" == fullscreen && "$state" == *"_NET_WM_STATE_FULLSCREEN"* ]]; then
        return 0
      fi
      if [[ "$expected" == windowed && "$state" != *"_NET_WM_STATE_FULLSCREEN"* ]]; then
        return 0
      fi
    fi
    sleep 0.05
  done
  printf 'Failed to reach %s at %s: %s\n' "$expected" "$size" "$state" >&2
  xwininfo -id "$window" >&2
  return 1
}

wait_state windowed 640x480
printf 'Before: %s\n' "$(geometry)"
xprop -id "$window" _NET_WM_STATE
xdotool key --window "$window" F11
wait_state fullscreen 1280x1024
printf 'Fullscreen: %s\n' "$(geometry)"
xprop -id "$window" _NET_WM_STATE
wmctrl -ir "$(printf '0x%x' "$window")" -b add,above
for _ in {1..200}; do
  state=$(xprop -id "$window" _NET_WM_STATE)
  if [[ "$state" == *"_NET_WM_STATE_ABOVE"* ]]; then break; fi
  sleep 0.05
done
if [[ "$state" != *"_NET_WM_STATE_ABOVE"* ]]; then
  printf 'Failed to set _NET_WM_STATE_ABOVE: %s\n' "$state" >&2
  exit 1
fi
xdotool key --window "$window" F12
wait_state windowed 640x480
printf 'Restored: %s\n' "$(geometry)"
state=$(xprop -id "$window" _NET_WM_STATE)
printf '%s\n' "$state"
if [[ "$state" != *"_NET_WM_STATE_ABOVE"* ]]; then
  printf 'Failed to preserve _NET_WM_STATE_ABOVE\n' >&2
  exit 1
fi
wmctrl -ic "$(printf '0x%x' "$window")"
wait "$probe_pid"
