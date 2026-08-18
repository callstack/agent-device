import childProcess from 'node:child_process';
import module from 'node:module';
import util from 'node:util';
import { afterAll, afterEach, expect } from 'vitest';

// Unit tests must be hermetic with respect to the host's process table: a
// worker may signal only itself and the processes it spawned. Anything else is
// a pid the test made up (`child: { pid: 4242 }`), and on a real host that
// number can belong to anyone — on CI it periodically belonged to a sibling
// vitest fork, which died mid-file with no test attributed
// ("Worker exited unexpectedly", #1824). Refusing the signal here, in every
// worker, turns that silent fork death into a named failure of the test that
// sent it, on any host, deterministically.
//
// Signal 0 is a liveness probe (`isProcessAlive`), not a signal; it stays free.
// A negative pid addresses a process group; it is allowed exactly when the
// group leader is a process this worker spawned (`runCmd`'s tree kill).
// Tests that drive a real kill path against a fabricated pid mock the signal
// seam (`signalPidsBestEffort` / `signalProcessGroupBestEffort` in
// `src/utils/host-process.ts`, or `vi.spyOn(process, 'kill')`) the same way
// they already mock the liveness reads.

const ownPids = new Set<number>([process.pid]);

function rememberChild(child: unknown): void {
  const pid = (child as { pid?: unknown } | null)?.pid;
  if (typeof pid === 'number') ownPids.add(pid);
}

function wrapSpawner<T extends (...args: never[]) => unknown>(real: T): T {
  const wrapped = ((...args: Parameters<T>) => {
    const child = real(...args);
    rememberChild(child);
    return child;
  }) as unknown as T;
  // `util.promisify(execFile)` resolves through the custom-promisify symbol.
  const custom = (real as unknown as Record<symbol, unknown>)[util.promisify.custom];
  if (custom) Object.defineProperty(wrapped, util.promisify.custom, { value: custom });
  return wrapped;
}

for (const name of ['spawn', 'spawnSync', 'fork', 'exec', 'execFile'] as const) {
  (childProcess as unknown as Record<string, unknown>)[name] = wrapSpawner(childProcess[name]);
}
// Named ESM imports of the builtin (`import { spawn } from 'node:child_process'`)
// bind to the CJS exports only after they are re-synced.
module.syncBuiltinESMExports();

const refused: string[] = [];

const realKill = process.kill.bind(process);
process.kill = ((pid: number, signal: string | number = 'SIGTERM') => {
  if (signal === 0 || ownPids.has(Math.abs(pid))) return realKill(pid, signal as NodeJS.Signals);
  const state = expect.getState();
  const where = new Error().stack?.split('\n').slice(2, 6).join('\n') ?? '';
  refused.push(
    `${String(signal)} -> pid ${pid} (${state.currentTestName ?? 'outside a test'})\n${where}`,
  );
  // Behave like a dead pid: the caller's ESRCH handling runs, no signal leaves
  // this worker, and the record above fails the test in afterEach below.
  const error = new Error(
    `Refusing to send ${String(signal)} to pid ${pid}: this vitest worker did not spawn it (see afterEach failure).`,
  ) as NodeJS.ErrnoException;
  error.code = 'ESRCH';
  throw error;
}) as typeof process.kill;

// Best-effort kill sites swallow the ESRCH above, so the refusal is reported
// here, attributed to the test (or file) that caused it, and never lost.
function failOnRefusedSignals(scope: string): void {
  if (refused.length === 0) return;
  const count = refused.length;
  const report = refused.splice(0).join('\n');
  throw new Error(
    `${scope} tried to send ${count} real signal(s) to a pid this vitest worker did not spawn. ` +
      'A unit test may signal only its own children (and their process groups); mock the signal ' +
      'seam in src/utils/host-process.ts (signalPidsBestEffort, signalProcessGroupBestEffort) or ' +
      `vi.spyOn(process, 'kill') instead.\n${report}`,
  );
}

afterEach(() => failOnRefusedSignals('This test'));
afterAll(() => failOnRefusedSignals('This file'));
