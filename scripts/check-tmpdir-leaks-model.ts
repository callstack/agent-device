import fs from 'node:fs';
import path from 'node:path';
import { runCmdSync } from '@agent-device/host-kit/command';
import {
  expandProcessTree,
  listHostProcesses,
  signalPidsBestEffort,
} from '@agent-device/host-kit/process';

// Every test run (Vitest via scripts/vitest-tmpdir-global-setup.ts, node --test
// via scripts/node-test-tmpdir.ts) redirects TMPDIR into one disposable,
// pid-tagged directory under this root and removes it at teardown.
//
// Rooted at /tmp rather than nested inside the current os.tmpdir(): macOS's
// per-user TMPDIR (/var/folders/.../T/) is already close to the 104-byte
// sun_path limit AF_UNIX sockets need, and tests that bind real sockets
// (e.g. runner-usbmux.test.ts) started hitting EINVAL once nested one level
// deeper. /tmp is short enough to leave headroom for those.
//
// Both redirection mechanisms and check-tmpdir-leaks.ts import these two from
// here rather than recomputing them, so they can't drift onto different
// directories (os.tmpdir() != /tmp on macOS, where TMPDIR is a deep per-user
// path).
export const TEST_RUN_TMP_ROOT = '/tmp';
export const TEST_RUN_TMP_PREFIX = 'agent-device-test-run-';

const PID_SUFFIX = new RegExp(`^${TEST_RUN_TMP_PREFIX}(\\d+)-`);

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but we lack permission to signal it — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The run directories some live process is still using: every process whose TMPDIR points
 * into one. That is the ownership signal every consumer actually carries — the run's own
 * setup exports it and every child (Vitest forks, the node --test chain, daemons a test
 * spawned) inherits it — so a run whose owner was SIGKILLed while its children kept running
 * is still "in use" until the last of them exits. Read from `ps -E` on macOS (environment
 * is shown for the caller's own processes) and /proc/<pid>/environ on Linux; on either, a
 * process this user cannot inspect contributes nothing, and its directory is then judged by
 * its owner pid alone.
 */
export function liveRunDirectoryConsumers(): ReadonlySet<string> {
  const consumers = new Set<string>();
  for (const { tmpdir } of readAllProcessTmpdirs()) {
    const name = runDirectoryNameOf(tmpdir);
    if (name !== undefined) consumers.add(name);
  }
  return consumers;
}

/**
 * SIGKILLs the process trees that tests left in `runDir` and returns one `<pid> <command>` line
 * per stopped process. A run's owner calls this after its test processes have exited and before
 * it removes the directory. A root is a Node process that holds `runDir` as TMPDIR and whose
 * parent is neither the owner nor another process of this run: a test fixture whose own cleanup
 * never ran (a killed worker, a timed-out test), reparented to init or a subreaper. Nothing
 * else would ever stop it. A shared tool that a test happened to start first (an adb server, an
 * emulator, watchman) runs another executable and is left alone, and so is any process whose
 * parent in this run still runs and can still clean it up.
 */
export async function stopRunDirectoryConsumers(runDir: string): Promise<string[]> {
  const name = runDirectoryNameOf(runDir);
  if (name === undefined) return [];
  const consumers = new Set(
    readAllProcessTmpdirs()
      .filter((entry) => entry.pid !== process.pid && runDirectoryNameOf(entry.tmpdir) === name)
      .map((entry) => entry.pid),
  );
  if (consumers.size === 0) return [];
  const runtime = path.basename(process.execPath);
  const processes = await listHostProcesses({ timeoutMs: 10_000 });
  const roots = processes.filter(
    (entry) =>
      consumers.has(entry.pid) &&
      entry.ppid !== undefined &&
      entry.ppid !== process.pid &&
      !consumers.has(entry.ppid) &&
      path.basename(entry.command.split(' ')[0] ?? '') === runtime,
  );
  const stopped = expandProcessTree(
    roots.map((entry) => entry.pid),
    processes,
  );
  signalPidsBestEffort(
    stopped.map((entry) => entry.pid),
    'SIGKILL',
  );
  return stopped.map((entry) => `${entry.pid} ${entry.command.slice(0, 300)}`.trimEnd());
}

/** One stderr block, only when a run's teardown had to stop processes its tests left behind. */
export function reportStoppedRunDirectoryConsumers(
  runDir: string,
  stopped: readonly string[],
): void {
  if (stopped.length === 0) return;
  process.stderr.write(
    `[tmpdir] stopped ${stopped.length} process${stopped.length === 1 ? '' : 'es'} still using ${runDir} at teardown:\n${stopped.map((line) => `  ${line}\n`).join('')}`,
  );
}

/** `/tmp/agent-device-test-run-123-abc/nested` → `agent-device-test-run-123-abc`; else undefined. */
export function runDirectoryNameOf(tmpdir: string): string | undefined {
  const rootPrefix = `${TEST_RUN_TMP_ROOT}/`;
  if (!tmpdir.startsWith(rootPrefix)) return undefined;
  const name = tmpdir.slice(rootPrefix.length).split('/')[0] ?? '';
  return name.startsWith(TEST_RUN_TMP_PREFIX) ? name : undefined;
}

type ProcessTmpdir = Readonly<{ pid: number; tmpdir: string }>;

function readAllProcessTmpdirs(): ProcessTmpdir[] {
  return process.platform === 'linux' ? readProcTmpdirs() : readPsTmpdirs();
}

function readProcTmpdirs(): ProcessTmpdir[] {
  return fs
    .readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .flatMap((pid) =>
      tmpdirsOfEnviron(readEnvironOrEmpty(pid)).map((tmpdir) => ({ pid: Number(pid), tmpdir })),
    );
}

/** Another user's process, or one that exited mid-scan, contributes nothing. */
function readEnvironOrEmpty(pid: string): string {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'latin1');
  } catch {
    return '';
  }
}

function tmpdirsOfEnviron(environ: string): string[] {
  return environ
    .split('\0')
    .filter((pair) => pair.startsWith('TMPDIR='))
    .map((pair) => pair.slice('TMPDIR='.length));
}

// macOS (and other BSDs): -E appends the environment to each command line. Every process's
// environment is a few MB on a busy host — well past spawnSync's 1 MB default.
function readPsTmpdirs(): ProcessTmpdir[] {
  const listing = runCmdSync('ps', ['-axEww', '-o', 'pid=,command='], {
    allowFailure: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listing.exitCode !== 0) return [];
  return listing.stdout.split('\n').flatMap((line) => {
    const pid = /^\s*(\d+)\s/.exec(line)?.[1];
    if (pid === undefined) return [];
    return [...line.matchAll(/\sTMPDIR=(\S+)/g)].map((match) => ({
      pid: Number(pid),
      tmpdir: match[1] as string,
    }));
  });
}

export type RunDirectoryLiveness = Readonly<{
  isAlive?: (pid: number) => boolean;
  consumers?: ReadonlySet<string>;
}>;

/**
 * A run directory is live while its owning process (the pid in its name) runs, OR while any
 * process still holds it as TMPDIR — a concurrent run in another worktree, or the orphaned
 * children of a killed run. Only the rest are leaks: nobody owns them and nobody uses them.
 */
export function findLeakedRunDirectories(
  root: string,
  liveness: RunDirectoryLiveness = {},
): string[] {
  const isAlive = liveness.isAlive ?? isProcessAlive;
  const consumers = liveness.consumers ?? liveRunDirectoryConsumers();
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(TEST_RUN_TMP_PREFIX))
    .filter((entry) => {
      if (consumers.has(entry.name)) return false;
      const match = PID_SUFFIX.exec(entry.name);
      // No parseable pid means it didn't come from setup() as written — treat it as a leak.
      if (!match) return true;
      return !isAlive(Number(match[1]));
    })
    .map((entry) => entry.name);
}

/**
 * Removes the run directories an earlier, already-exited run left behind and
 * returns their names. A run's setup calls this before creating its own
 * directory, so the post-run leak check (check-tmpdir-leaks.ts) can only ever
 * report the run that just finished: a directory abandoned by an earlier run
 * that was killed before its teardown (SIGKILL on a tool timeout, OOM, a
 * cancelled CI job) is by construction the same thing that teardown would have
 * removed, and leaving it in place made every later, otherwise-green gate on
 * the host fail for a run it never ran. Live owners are never touched, so a
 * concurrent run in another worktree keeps its directory.
 */
export function pruneAbandonedRunDirectories(
  root: string,
  liveness: RunDirectoryLiveness = {},
): string[] {
  const abandoned = findLeakedRunDirectories(root, liveness);
  for (const name of abandoned) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
  return abandoned;
}

/**
 * One stderr line, only when something was pruned: an earlier run on this
 * host died before its teardown, which the operator should know (a tool
 * timeout killed it, say) without it being a failure of this run.
 */
export function reportPrunedRunDirectories(pruned: readonly string[]): void {
  if (pruned.length === 0) return;
  process.stderr.write(
    `[tmpdir] pruned ${pruned.length} abandoned ${TEST_RUN_TMP_PREFIX}* director${pruned.length === 1 ? 'y' : 'ies'} left by an earlier killed run\n`,
  );
}
