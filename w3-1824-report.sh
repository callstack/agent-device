#!/usr/bin/env bash
# SCRATCH (w3-1824): after the coverage run, report which sentinels survived,
# what signals they saw, whether the kernel OOM-killed anything, and every real
# signal a vitest fork sent to a foreign pid (from the kill tracer).
set -uo pipefail
LOG_DIR="${1:?log dir}"
TRACE="${2:?trace file}"

echo "== sentinels"
if [ -f "$LOG_DIR/sentinels.txt" ]; then
  while read -r pid; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "pid $pid: ALIVE ($(ps -o cmd= -p "$pid" | cut -c1-80))"
    else
      echo "pid $pid: DEAD"
    fi
    cat "$LOG_DIR/sentinel-$pid.log" 2>/dev/null | sed 's/^/    /'
  done < "$LOG_DIR/sentinels.txt"
else
  echo "(none planted)"
fi

echo "== kernel OOM / kill lines"
(sudo dmesg 2>/dev/null || dmesg 2>/dev/null) | grep -iE 'out of memory|oom-kill|killed process' || echo "(none)"

echo "== kill trace"
if [ -f "$TRACE" ]; then
  node - "$TRACE" <<'EOF'
const fs = require('node:fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rel = (f) => (f || '?').replace(/.*\/agent-device\/agent-device\//, '');
const starts = lines.filter((e) => e.kind === 'file-start');
console.log(`${lines.length} events, ${starts.length} files; worker pids ${Math.min(...starts.map((e) => e.workerPid))}..${Math.max(...starts.map((e) => e.workerPid))}; pgid(s) ${[...new Set(starts.map((e) => e.workerPgid))].join(',')}`);
const firstUnit = starts.find((e) => rel(e.file).startsWith('src/'));
if (firstUnit) console.log(`first src/ file ${rel(firstUnit.file)} started at ${firstUnit.ts} in worker pid ${firstUnit.workerPid}`);
const kills = lines.filter((e) => e.kind === 'process.kill' || e.kind === 'spawn');
const byFile = new Map();
for (const e of kills) {
  const key = rel(e.file);
  const what = e.kind === 'spawn' ? `spawn ${e.command} ${e.args.join(' ')}` : `kill ${e.pid} ${e.signal}`;
  const m = byFile.get(key) ?? new Map();
  m.set(what, (m.get(what) ?? 0) + 1);
  byFile.set(key, m);
}
for (const [file, m] of byFile) {
  console.log(`-- ${file}`);
  for (const [what, n] of m) console.log(`   ${n}x ${what}`);
}
const forkPids = new Set(starts.map((e) => e.workerPid));
const hits = kills.filter((e) => e.kind === 'process.kill' && forkPids.has(Math.abs(e.pid)));
console.log(`== signals aimed at a pid that was also a vitest fork in this run: ${hits.length}`);
for (const e of hits) console.log(`   ${e.ts} ${rel(e.file)} -> kill ${e.pid} ${e.signal} (fork ran ${rel(starts.find((s) => s.workerPid === Math.abs(e.pid))?.file)})`);
EOF
else
  echo "(no trace file at $TRACE)"
fi
