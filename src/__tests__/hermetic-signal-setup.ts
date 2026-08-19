import childProcess from 'node:child_process';
import module from 'node:module';
import util from 'node:util';
import { afterAll, afterEach, expect } from 'vitest';

// Unit tests must be hermetic with respect to the host's process table: a
// worker may signal only itself and its own direct children. Anything else is
// a pid the test made up (`child: { pid: 4242 }`), and on a real host that
// number can belong to anyone — on CI it periodically belonged to a sibling
// vitest fork, which died mid-file with no test attributed
// ("Worker exited unexpectedly", #1824). Refusing the write here, in every
// worker, turns that silent fork death into a named failure of the test that
// sent it, on any host, deterministically.
//
// Both ways out of the process are covered, because the runner-disposal family
// uses both: `process.kill` (including the negative pid that addresses a
// child's process group) and a spawned `kill`/`pkill`/`killall`, whose `-P`
// and `-f` forms reach processes this worker never spawned at all.
//
// Signal 0 is a liveness probe (`isProcessAlive`), not a signal; it stays free.
// Tests that drive a real kill path against a fabricated pid mock the seam —
// `signalPidsBestEffort` / `signalProcessGroupBestEffort` in
// `src/utils/host-process.ts` for the direct writes, the exec/tool-provider
// seam for a spawned `pkill` — the same way they already mock the liveness
// reads.

/**
 * Direct children only. A grandchild (a server started through a shell or
 * `npx` wrapper) is not tracked, so signalling its pid is refused even though
 * the test legitimately owns it; signal the direct child, or its process group
 * via the negative pid, or mock the seam.
 *
 * Synchronous spawns (`spawnSync`, `execFileSync`) are deliberately not
 * remembered: they have already exited by the time the call returns, so
 * remembering them would license a signal to whatever inherits that pid next —
 * the very hazard this file closes. Asynchronous children are remembered for
 * the worker's lifetime rather than evicted on exit, because tests legitimately
 * signal a child they have already reaped (idempotent cleanup); with
 * `isolate: true` a worker runs one file, so the set stays small and
 * short-lived.
 */
const ownPids = new Set<number>([process.pid]);

const KILL_BINARIES = new Set(['kill', 'pkill', 'killall']);

const refused: string[] = [];

function record(what: string): void {
  const state = expect.getState();
  const where = new Error().stack?.split('\n').slice(3, 7).join('\n') ?? '';
  refused.push(`${what} (${state.currentTestName ?? 'outside a test'})\n${where}`);
}

function rememberChild(child: unknown): void {
  const pid = (child as { pid?: unknown } | null)?.pid;
  if (typeof pid === 'number') ownPids.add(pid);
}

function killBinaryName(command: unknown): string | undefined {
  // `exec` takes a shell command line; the rest take an executable path.
  const first = String(command).trim().split(/\s+/)[0] ?? '';
  const name = first.split('/').pop() ?? '';
  return KILL_BINARIES.has(name) ? name : undefined;
}

function refuseSpawnedKill(command: unknown, args: unknown): Error | undefined {
  const name = killBinaryName(command);
  if (!name) return undefined;
  const rendered = [String(command), ...(Array.isArray(args) ? args.map(String) : [])].join(' ');
  record(`spawn ${rendered}`);
  // Shaped like the binary being unavailable, which every caller of these
  // best-effort kills already tolerates.
  const error = new Error(
    `Refusing to spawn \`${rendered}\`: a unit test may not signal processes through ${name} (see afterEach failure).`,
  ) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function wrapSpawner<T extends (...args: never[]) => unknown>(real: T, remember: boolean): T {
  const wrapped = ((...args: Parameters<T>) => {
    const refusal = refuseSpawnedKill(args[0], args[1]);
    if (refusal) throw refusal;
    const child = real(...args);
    if (remember) rememberChild(child);
    return child;
  }) as unknown as T;
  // `util.promisify(execFile)` resolves through the custom-promisify symbol.
  const custom = (real as unknown as Record<symbol, unknown>)[util.promisify.custom];
  if (custom) Object.defineProperty(wrapped, util.promisify.custom, { value: custom });
  return wrapped;
}

for (const name of ['spawn', 'fork', 'exec', 'execFile'] as const) {
  (childProcess as unknown as Record<string, unknown>)[name] = wrapSpawner(
    childProcess[name],
    true,
  );
}
for (const name of ['spawnSync', 'execFileSync', 'execSync'] as const) {
  (childProcess as unknown as Record<string, unknown>)[name] = wrapSpawner(
    childProcess[name],
    false,
  );
}
// Named ESM imports of the builtin (`import { spawn } from 'node:child_process'`)
// bind to the CJS exports only after they are re-synced.
module.syncBuiltinESMExports();

const realKill = process.kill.bind(process);
process.kill = ((pid: number, signal: string | number = 'SIGTERM') => {
  if (signal === 0 || ownPids.has(Math.abs(pid))) return realKill(pid, signal as NodeJS.Signals);
  record(`${String(signal)} -> pid ${pid}`);
  // Behave like a dead pid: the caller's ESRCH handling runs, no signal leaves
  // this worker, and the record above fails the test in afterEach below.
  const error = new Error(
    `Refusing to send ${String(signal)} to pid ${pid}: this vitest worker did not spawn it (see afterEach failure).`,
  ) as NodeJS.ErrnoException;
  error.code = 'ESRCH';
  throw error;
}) as typeof process.kill;

// Best-effort kill sites swallow the errors above, so the refusal is reported
// here, attributed to the test (or file) that caused it, and never lost.
function failOnRefusedSignals(scope: string): void {
  if (refused.length === 0) return;
  const count = refused.length;
  const report = refused.splice(0).join('\n');
  throw new Error(
    `${scope} tried to signal ${count} process(es) this vitest worker did not spawn. ` +
      'A unit test may signal only itself and its own direct children (and their process ' +
      'groups); mock the seam instead — signalPidsBestEffort / signalProcessGroupBestEffort in ' +
      'src/utils/host-process.ts, the exec or tool-provider seam for a spawned pkill, or ' +
      `vi.spyOn(process, 'kill'). If the pid is a descendant this test really owns, signal the ` +
      `direct child (or its group via the negative pid) rather than the grandchild.\n${report}`,
  );
}

afterEach(() => failOnRefusedSignals('This test'));
afterAll(() => failOnRefusedSignals('This file'));
