// Daemon leak oracle (#1781 B1, feeds #1431). The real-subprocess daemon lanes
// (smoke-daemon-clean, smoke-daemon-http, daemon-replace-exit-flush) call it at
// their end to answer one question: after `close` and after daemon shutdown,
// did the daemon leave anything it OWNS behind?
//
// Ownership is explicit and conservative. Global process counts are not
// evidence — the simulator, XCTest, and Chrome-for-Testing own processes this
// daemon does not. A host process is daemon-owned when ANY rule holds:
//
//   descendant     its PPID chain reaches a daemon pid (observable only while
//                  that daemon lives; orphans reparent to launchd/init).
//   process-group  its PGID equals a daemon pid. The CLI launches the daemon
//                  detached (setsid), so the daemon is its own group leader and
//                  every non-detached runCmdBackground child stays in that group
//                  after reparenting. This is the #1324 signature: `simctl io …
//                  recordVideo` with PPID 1 and PGID = the dead daemon's pid.
//                  POSIX keeps a pgid reserved while any member lives, so it
//                  cannot be recycled under the check.
//   state-dir-env  its environment carries AGENT_DEVICE_STATE_DIR=<state dir>.
//                  The CLI starts the daemon with that variable and children
//                  inherit it, including setsid'd grandchildren the pgid rule
//                  misses (agent-browser's own daemon → Chrome fleet: #1109).
//                  macOS hides the environment of Apple platform binaries
//                  (`ps -E` shows it for node/Chrome, not for /bin/sleep or
//                  simctl), so Apple tooling is caught by the pgid/argv rules.
//   state-dir-argv its command line contains the state dir path (recorders
//                  writing session artifacts, browsers pinned to a managed home).
//
// The lanes use a fresh mkdtemp state dir per run, so env/argv rules cannot
// match a foreign process. The oracle also excludes itself and its ancestors.
//
// State-dir residue: after shutdown every entry must match
// EXPECTED_STATE_DIR_ENTRIES (unknown ⇒ classify the new artifact, do not widen
// the matcher), `*.tmp` write-then-publish temporaries always fail (torn
// publish), daemon.json/daemon.lock may exist only while a daemon lives, and a
// durable capture descriptor still `lifecycle: "open"` (or a legacy
// `app-log.pid` marker) after shutdown means a capture handle outlived its
// owner — a `completed` descriptor is the finish record ADR 0019 keeps.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCmd } from '../../../src/utils/exec.ts';
import { isProcessAlive } from '../../../src/utils/host-process.ts';

const PS_TIMEOUT_MS = 5_000;
const DEFAULT_SETTLE_MS = 5_000;
const SETTLE_POLL_MS = 250;
const COMMAND_PREVIEW_CHARS = 160;

export type DaemonLeakPhase = 'after-close' | 'after-shutdown';

type OwnershipReason = 'descendant' | 'process-group' | 'state-dir-env' | 'state-dir-argv';

type OwnedProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
  reasons: OwnershipReason[];
};

type DaemonLeakSnapshot = {
  stateDir: string;
  daemonPids: number[];
  phase: DaemonLeakPhase;
  liveDaemonPids: number[];
  ownedProcesses: OwnedProcess[];
  strayStateEntries: string[];
};

export type DaemonLeakOracleOptions = {
  stateDir: string;
  /** Every daemon pid the lane observed for this state dir (from daemon.json). */
  daemonPids: readonly number[];
  phase: DaemonLeakPhase;
  /** How long stragglers may take to exit before they count as leaked. */
  settleMs?: number;
};

type HostProcess = { pid: number; ppid: number; pgid: number; command: string; env: string };

// Relative-path matchers for everything the daemon may legitimately leave in a
// state dir. `daemon.json`/`daemon.lock` are additionally gated on a live
// daemon; capture descriptors are gated on the phase (see classifyStateEntry).
const EXPECTED_STATE_DIR_ENTRIES: readonly RegExp[] = [
  /^daemon\.json$/,
  /^daemon\.lock$/,
  /^daemon\.log$/,
  /^daemon-shutdown\.json$/,
  /^sessions\/[^/]+\/events\.ndjson$/,
  /^sessions\/[^/]+\/requests\/[^/]+\.ndjson$/,
  /^sessions\/[^/]+\/(?:app|runner)\.log$/,
  /^sessions\/[^/]+\/repair-tombstone\.json$/,
  /^sessions\/[^/]+\/artifacts\/.+$/,
  /^tools\/.+$/,
  /^device-claims\/.+$/,
];
const CAPTURE_DESCRIPTOR_ENTRY = /^sessions\/[^/]+\/[^/]+\.resource\.json$/;
const LEGACY_APP_LOG_MARKER_ENTRY = /^sessions\/[^/]+\/app-log\.pid$/;
const DAEMON_LIVENESS_ENTRY = /^daemon\.(?:json|lock)$/;

async function captureDaemonLeakSnapshot(
  options: DaemonLeakOracleOptions,
): Promise<DaemonLeakSnapshot> {
  const stateDir = path.resolve(options.stateDir);
  const daemonPids = uniquePids(options.daemonPids);
  const processes = await listHostProcesses();
  const liveDaemonPids = daemonPids.filter((pid) => isProcessAlive(pid));
  return {
    stateDir,
    daemonPids,
    phase: options.phase,
    liveDaemonPids,
    ownedProcesses: findOwnedProcesses(processes, daemonPids, stateDir),
    strayStateEntries: listStateEntries(stateDir).filter(
      (entry) =>
        classifyStateEntry(stateDir, entry, options.phase, liveDaemonPids.length > 0) !==
        'expected',
    ),
  };
}

function findOwnedProcesses(
  processes: readonly HostProcess[],
  daemonPids: readonly number[],
  stateDir: string,
): OwnedProcess[] {
  const excluded = new Set([...ancestorsOf(process.pid, processes), ...daemonPids]);
  const reasonsByPid = new Map<number, OwnershipReason[]>();
  for (const proc of processes) {
    if (excluded.has(proc.pid)) continue;
    const reasons = directOwnershipReasons(proc, daemonPids, stateDir);
    if (reasons.length > 0) reasonsByPid.set(proc.pid, reasons);
  }
  // Ownership propagates down the tree: a child of the daemon, or of any
  // process the rules above own, is owned (a detached `(simctl)` grandchild of
  // a leaked recorder shim, DTServiceHub under a runner xcodebuild, …).
  for (const pid of descendantsOf([...daemonPids, ...reasonsByPid.keys()], processes)) {
    if (excluded.has(pid)) continue;
    reasonsByPid.set(pid, [...(reasonsByPid.get(pid) ?? []), 'descendant']);
  }
  return processes.flatMap((proc) => {
    const reasons = reasonsByPid.get(proc.pid);
    return reasons
      ? [{ pid: proc.pid, ppid: proc.ppid, pgid: proc.pgid, command: proc.command, reasons }]
      : [];
  });
}

function directOwnershipReasons(
  proc: HostProcess,
  daemonPids: readonly number[],
  stateDir: string,
): OwnershipReason[] {
  // Whole-path matches only: `<dir>` as a token or `<dir>/…`, never `<dir>-sibling`.
  const stateDirToken = new RegExp(`(?:^|[\\s=])${escapeRegExp(stateDir)}(?:[\\s/]|$)`);
  const stateDirEnv = new RegExp(`AGENT_DEVICE_STATE_DIR=${escapeRegExp(stateDir)}(?:\\s|$)`);
  const reasons: OwnershipReason[] = [];
  if (daemonPids.includes(proc.pgid)) reasons.push('process-group');
  if (stateDirEnv.test(proc.env)) reasons.push('state-dir-env');
  if (stateDirToken.test(proc.command)) reasons.push('state-dir-argv');
  return reasons;
}

function hasDaemonLeaks(snapshot: DaemonLeakSnapshot): boolean {
  return snapshot.ownedProcesses.length > 0 || snapshot.strayStateEntries.length > 0;
}

/**
 * Re-snapshots until clean or `settleMs` elapses. Stragglers that exit on their
 * own inside the window are not leaks; #1324/#1109 orphans never exit on their own.
 */
async function settleDaemonLeakSnapshot(
  options: DaemonLeakOracleOptions,
): Promise<DaemonLeakSnapshot> {
  const deadline = Date.now() + (options.settleMs ?? DEFAULT_SETTLE_MS);
  let snapshot = await captureDaemonLeakSnapshot(options);
  while (hasDaemonLeaks(snapshot) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    snapshot = await captureDaemonLeakSnapshot(options);
  }
  return snapshot;
}

/** Throws with the full report if anything daemon-owned survives the settle window. */
export async function assertNoDaemonLeaks(options: DaemonLeakOracleOptions): Promise<void> {
  const snapshot = await settleDaemonLeakSnapshot(options);
  if (hasDaemonLeaks(snapshot)) throw new Error(formatDaemonLeakReport(snapshot));
}

function formatDaemonLeakReport(snapshot: DaemonLeakSnapshot): string {
  const lines = [
    `daemon leak oracle: ${hasDaemonLeaks(snapshot) ? 'LEAK' : 'clean'} (${snapshot.phase})`,
    `  state dir: ${snapshot.stateDir}`,
    `  daemon pids: ${snapshot.daemonPids.join(', ') || '(none)'}; live: ${
      snapshot.liveDaemonPids.join(', ') || '(none)'
    }`,
    `  owned processes still alive: ${snapshot.ownedProcesses.length}`,
    ...snapshot.ownedProcesses.map((proc) => {
      const command = proc.command.replace(
        new RegExp(`${escapeRegExp(snapshot.stateDir)}(?=[\\s/]|$)`, 'g'),
        '<state-dir>',
      );
      const preview =
        command.length > COMMAND_PREVIEW_CHARS
          ? `${command.slice(0, COMMAND_PREVIEW_CHARS)}…`
          : command;
      return `    pid ${proc.pid} ppid ${proc.ppid} pgid ${proc.pgid} [${proc.reasons.join(',')}] ${preview}`;
    }),
    `  stray state-dir entries: ${snapshot.strayStateEntries.length}`,
    ...snapshot.strayStateEntries.map((entry) => `    ${entry}`),
  ];
  return lines.join('\n');
}

function classifyStateEntry(
  stateDir: string,
  entry: string,
  phase: DaemonLeakPhase,
  daemonAlive: boolean,
): 'expected' | 'stray' {
  if (entry.endsWith('.tmp')) return 'stray';
  if (DAEMON_LIVENESS_ENTRY.test(entry)) return daemonAlive ? 'expected' : 'stray';
  if (CAPTURE_DESCRIPTOR_ENTRY.test(entry) || LEGACY_APP_LOG_MARKER_ENTRY.test(entry)) {
    return classifyCaptureEntry(stateDir, entry, phase);
  }
  return EXPECTED_STATE_DIR_ENTRIES.some((matcher) => matcher.test(entry)) ? 'expected' : 'stray';
}

// Other sessions may still hold live captures while this one closes; after
// shutdown only a completed capture record may remain (never a pid marker).
function classifyCaptureEntry(
  stateDir: string,
  entry: string,
  phase: DaemonLeakPhase,
): 'expected' | 'stray' {
  if (phase === 'after-close') return 'expected';
  if (!CAPTURE_DESCRIPTOR_ENTRY.test(entry)) return 'stray';
  return readDescriptorLifecycle(path.join(stateDir, entry)) === 'completed' ? 'expected' : 'stray';
}

function readDescriptorLifecycle(filePath: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { lifecycle?: unknown };
    return typeof parsed.lifecycle === 'string' ? parsed.lifecycle : undefined;
  } catch {
    return undefined;
  }
}

function listStateEntries(stateDir: string): string[] {
  if (!fs.existsSync(stateDir)) return [];
  return fs
    .readdirSync(stateDir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      path.relative(stateDir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    )
    .sort();
}

// pid/ppid/pgid plus the command line, and separately the environment so the
// argv and env rules stay distinct. macOS `ps -E` appends the environment to
// the command line for same-user processes; Linux exposes it in /proc.
async function listHostProcesses(): Promise<HostProcess[]> {
  const darwin = process.platform === 'darwin';
  const [tree, darwinEnv] = await Promise.all([
    runPs(['-axww', '-o', 'pid=,ppid=,pgid=,command=']),
    darwin ? runPs(['-E', '-axww', '-o', 'pid=,command=']) : Promise.resolve(''),
  ]);
  const envByPid = new Map(
    parsePsLines(darwinEnv, /^\s*(\d+)\s+(.*)$/).map(([pid, env]) => [Number(pid), env ?? '']),
  );
  return parsePsLines(tree, /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/).map(
    ([pid, ppid, pgid, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      command: command ?? '',
      env: darwin ? (envByPid.get(Number(pid)) ?? '') : readLinuxEnviron(Number(pid)),
    }),
  );
}

function parsePsLines(stdout: string, shape: RegExp): string[][] {
  return stdout.split('\n').flatMap((line) => {
    const match = shape.exec(line);
    return match ? [match.slice(1)] : [];
  });
}

async function runPs(args: string[]): Promise<string> {
  const result = await runCmd('ps', args, { allowFailure: true, timeoutMs: PS_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw new Error(
      `daemon leak oracle: ps ${args.join(' ')} failed (${result.exitCode}): ${result.stderr}`,
    );
  }
  return result.stdout;
}

function readLinuxEnviron(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'latin1').replaceAll('\0', ' ');
  } catch {
    return '';
  }
}

function descendantsOf(
  rootPids: readonly number[],
  processes: readonly HostProcess[],
): Set<number> {
  const selected = new Set(rootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const proc of processes) {
      if (!selected.has(proc.ppid) || selected.has(proc.pid)) continue;
      selected.add(proc.pid);
      changed = true;
    }
  }
  for (const pid of rootPids) selected.delete(pid);
  return selected;
}

function ancestorsOf(pid: number, processes: readonly HostProcess[]): Set<number> {
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const chain = new Set<number>();
  for (let cursor = pid; cursor > 0 && !chain.has(cursor); cursor = byPid.get(cursor)?.ppid ?? 0) {
    chain.add(cursor);
  }
  return chain;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniquePids(pids: readonly number[]): number[] {
  return [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
}

// Standalone use (red-proofs, manual triage):
//   node --experimental-strip-types test/integration/support/daemon-leak-oracle.ts \
//     --state-dir <dir> --daemon-pid <pid> [--daemon-pid <pid>…] \
//     [--phase after-shutdown|after-close] [--settle-ms <n>]
// Prints the report and exits 1 on a leak.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const readFlag = (name: string): string[] =>
    args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]!] : []));
  const stateDir = readFlag('--state-dir')[0];
  if (!stateDir) throw new Error('daemon leak oracle: --state-dir is required');
  const snapshot = await settleDaemonLeakSnapshot({
    stateDir,
    daemonPids: readFlag('--daemon-pid').map(Number),
    phase: (readFlag('--phase')[0] as DaemonLeakPhase | undefined) ?? 'after-shutdown',
    settleMs: Number(readFlag('--settle-ms')[0] ?? DEFAULT_SETTLE_MS),
  });
  process.stdout.write(`${formatDaemonLeakReport(snapshot)}\n`);
  process.exitCode = hasDaemonLeaks(snapshot) ? 1 : 0;
}
