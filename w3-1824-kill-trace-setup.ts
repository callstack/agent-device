// fallow-ignore-file unused-file
// SCRATCH (w3-1824): traces every real signal a vitest fork sends to a foreign
// pid, plus every `kill`/`pkill` subprocess it spawns. Appends NDJSON lines to
// $W3_1824_KILL_TRACE. Never committed.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import module from 'node:module';
import util from 'node:util';
import { beforeAll, expect } from 'vitest';

const out = process.env.W3_1824_KILL_TRACE;

function currentTest(): { file?: string; name?: string } {
  try {
    const state = expect.getState();
    return { file: state.testPath, name: state.currentTestName };
  } catch {
    return {};
  }
}

function readPgid(): number | undefined {
  try {
    // /proc/self/stat: pid (comm) state ppid pgrp ...
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(afterComm[2]);
  } catch {
    return undefined;
  }
}

function record(entry: Record<string, unknown>): void {
  if (!out) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    workerPid: process.pid,
    workerPpid: process.ppid,
    workerPgid: readPgid(),
    ...currentTest(),
    ...entry,
  });
  fs.appendFileSync(out, `${line}\n`);
}

const realKill = process.kill.bind(process);
process.kill = ((pid: number, signal?: string | number) => {
  // signal 0 is a liveness probe; ignore self-signals.
  if (signal !== 0 && pid !== process.pid) {
    record({
      kind: 'process.kill',
      pid,
      signal: signal ?? 'SIGTERM',
      stack: new Error().stack?.split('\n').slice(2, 9).join(' | '),
    });
  }
  return realKill(pid, signal as never);
}) as typeof process.kill;

const KILL_BINARIES = new Set(['kill', 'pkill', 'killall']);

function traceSpawn(cmd: unknown, args: unknown): void {
  const command = String(cmd);
  if (!KILL_BINARIES.has(command.split('/').pop() ?? '')) return;
  record({
    kind: 'spawn',
    command,
    args: Array.isArray(args) ? args : [],
    stack: new Error().stack?.split('\n').slice(3, 10).join(' | '),
  });
}

for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync'] as const) {
  const real = childProcess[name] as (...a: unknown[]) => unknown;
  const wrapped = (...a: unknown[]) => {
    traceSpawn(a[0], a[1]);
    return real(...a);
  };
  // util.promisify(execFile) relies on the custom promisify symbol; keep it.
  const custom = (real as unknown as Record<symbol, unknown>)[util.promisify.custom];
  if (custom) Object.defineProperty(wrapped, util.promisify.custom, { value: custom });
  (childProcess as unknown as Record<string, unknown>)[name] = wrapped;
}

// Named ESM imports of the builtin (`import { spawn } from 'node:child_process'`)
// only see the patched functions after the CJS exports are re-synced.
module.syncBuiltinESMExports();
record({ kind: 'worker-start' });
beforeAll(() => {
  record({ kind: 'file-start' });
});
