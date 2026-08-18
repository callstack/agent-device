#!/usr/bin/env bash
# SCRATCH (w3-1824): park a sentinel process on each pid the runner-session and
# runner-request-cancellation tests fabricate (4141, 4242, 4343, 4444). Linux
# allocates pids sequentially, so the script spawns throwaway subshells until
# the counter sits just below each target and then starts the sentinel there.
# No privileges, no kernel knobs: just process creation.
set -euo pipefail
LOG_DIR="${1:?log dir}"
mkdir -p "$LOG_DIR"
echo "nproc=$(nproc) mem=$(free -m | awk '/Mem:/ {print $2}')MB pid_max=$(cat /proc/sys/kernel/pid_max)"
echo "step shell: pid/ppid/pgid/sid = $(ps -o pid=,ppid=,pgid=,sid= -p $$)"
SENTINEL="$(cd "$(dirname "$0")" && pwd)/w3-1824-sentinel.cjs"

for target in 4141 4242 4343 4444; do
  if kill -0 "$target" 2>/dev/null; then
    echo "pid $target already taken by: $(ps -o cmd= -p "$target")"
    continue
  fi
  spawned=0
  while :; do
    ( : ) &
    p=$!
    wait "$p" || true
    spawned=$((spawned + 1))
    if [ "$p" -eq $((target - 1)) ]; then break; fi
    if [ "$p" -gt $((target - 1)) ]; then
      echo "missed $target (counter already at $p after $spawned spawns)"
      p=""
      break
    fi
    if [ "$spawned" -gt 20000 ]; then
      echo "gave up on $target after $spawned spawns (counter at $p)"
      p=""
      break
    fi
  done
  [ -n "$p" ] || continue
  node "$SENTINEL" "$LOG_DIR/sentinel-$target.log" &
  pid=$!
  if [ "$pid" -eq "$target" ]; then
    echo "sentinel planted at pid $pid after $spawned spawns: $(ps -o pid=,ppid=,pgid=,sid=,cmd= -p "$pid")"
    echo "$pid" >> "$LOG_DIR/sentinels.txt"
  else
    echo "sentinel landed on $pid instead of $target; killing it"
    kill "$pid" 2>/dev/null || true
  fi
done
disown -a 2>/dev/null || true
echo "sentinels: $(cat "$LOG_DIR/sentinels.txt" 2>/dev/null | tr '\n' ' ')"
