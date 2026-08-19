// Daemon leak oracle (#1781 B1, feeds #1431): observes the host process table
// and an isolated state dir, then applies the ownership/residue rules in
// `daemon-leak-model.ts` (which documents them and is where they are tested).
//
// What each caller actually exercises depends on what its daemon did. The three
// real-subprocess daemon lanes run `session list`/`close` with no device,
// simulator or browser, so their daemons own no children and the process arm
// asserts an empty set; what they guard is the surviving-daemon check and the
// state-dir residue. The #1109/#1324 leak shapes are guarded by the model's
// fixture test and reproduced by hand against the pre-fix commits — see the PR.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCmd } from '../../../src/utils/exec.ts';
import { isProcessAlive } from '../../../src/utils/host-process.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  evaluateDaemonLeaks,
  formatDaemonLeakReport,
  hasDaemonLeaks,
  type DaemonLeakPhaseSelection,
  type DaemonLeakSnapshot,
  type HostProcess,
  type StateEntry,
} from './daemon-leak-model.ts';

const PS_TIMEOUT_MS = 5_000;
const DEFAULT_SETTLE_MS = 5_000;
const SETTLE_POLL_MS = 250;
// Matches src/utils/host-process.ts: an absolute path so a PATH-resolved
// third-party `ps` (Homebrew, procps) cannot change the flag semantics.
const HOST_PS_COMMAND = process.platform === 'win32' ? 'ps' : '/bin/ps';

/**
 * `phase` carries the identity that phase needs: `after-close` cannot be
 * requested without naming at least one closed session (see
 * DaemonLeakPhaseSelection), so the vacuous checkpoint that accepts every open
 * capture handle is not expressible. `after-shutdown` takes nothing extra.
 *
 * Closed sessions are directory names, not paths — the basename of
 * `sessionStore.resolveSessionDir(name)`, or of the `sessionStateDir` an
 * `open`/`close` response reports.
 */
export type DaemonLeakOracleOptions = DaemonLeakPhaseSelection & {
  stateDir: string;
  /** Every daemon pid the lane observed for this state dir (from daemon.json). */
  daemonPids: readonly number[];
  /**
   * Where sessions live, when that is not `<stateDir>/sessions` — an in-process
   * scenario harness roots its SessionStore directly at its own temp dir.
   * Entries below it are normalized to the canonical `sessions/<name>/…` shape
   * so the rules stay layout-independent.
   */
  sessionsDir?: string;
  /** How long stragglers may take to exit before they count as leaked. */
  settleMs?: number;
};

async function captureDaemonLeakSnapshot(
  options: DaemonLeakOracleOptions,
): Promise<DaemonLeakSnapshot> {
  const stateDir = path.resolve(options.stateDir);
  const processes = await listHostProcessesWithGroups();
  return evaluateDaemonLeaks({
    ...phaseSelectionOf(options),
    stateDir,
    daemonPids: options.daemonPids,
    livePids: options.daemonPids.filter((pid) => isProcessAlive(pid)),
    processes,
    excludedPids: [...ancestorsOf(process.pid, processes)],
    stateEntries: readStateEntries(stateDir, options.sessionsDir),
  });
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

function phaseSelectionOf(options: DaemonLeakOracleOptions): DaemonLeakPhaseSelection {
  return options.phase === 'after-close'
    ? { phase: 'after-close', closedSessions: options.closedSessions }
    : { phase: 'after-shutdown' };
}

// Files, plus empty directories as their own entries (an unswept session
// scaffold leaves no file behind), plus the `lifecycle` of durable capture
// descriptors so the rules stay free of filesystem access.
function readStateEntries(stateDir: string, sessionsDir?: string): StateEntry[] {
  if (!fs.existsSync(stateDir)) return [];
  const sessionsRoot = path.resolve(sessionsDir ?? path.join(stateDir, 'sessions'));
  const entries: StateEntry[] = [];
  for (const dirent of fs.readdirSync(stateDir, { recursive: true, withFileTypes: true })) {
    const absolute = path.join(dirent.parentPath, dirent.name);
    const relative = toCanonicalEntryPath(absolute, stateDir, sessionsRoot);
    if (!dirent.isDirectory()) {
      entries.push({
        path: relative,
        kind: 'file',
        ...(relative.endsWith('.resource.json')
          ? { descriptorLifecycle: readDescriptorLifecycle(absolute) }
          : {}),
      });
    } else if (isEmptyDirectory(absolute)) {
      entries.push({ path: `${relative}/`, kind: 'empty-directory' });
    }
  }
  return entries;
}

// `sessions/<name>/…` regardless of where the SessionStore is rooted.
function toCanonicalEntryPath(absolute: string, stateDir: string, sessionsRoot: string): string {
  const withinSessions = path.relative(sessionsRoot, absolute);
  const relative =
    withinSessions.startsWith('..') || path.isAbsolute(withinSessions)
      ? path.relative(stateDir, absolute)
      : path.join('sessions', withinSessions);
  return relative.split(path.sep).join('/');
}

function isEmptyDirectory(directoryPath: string): boolean {
  try {
    return fs.readdirSync(directoryPath).length === 0;
  } catch {
    return false;
  }
}

function readDescriptorLifecycle(filePath: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { lifecycle?: unknown };
    return typeof parsed.lifecycle === 'string' ? parsed.lifecycle : undefined;
  } catch {
    return undefined;
  }
}

// src/utils/host-process.ts's listHostProcesses covers pid/ppid/command; the
// ownership rules also need the process group and the environment, which need a
// second `ps` on macOS (`-E` appends the environment to the command column) and
// /proc on Linux.
async function listHostProcessesWithGroups(): Promise<HostProcess[]> {
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
  const result = await runCmd(HOST_PS_COMMAND, args, {
    allowFailure: true,
    timeoutMs: PS_TIMEOUT_MS,
  });
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

function ancestorsOf(pid: number, processes: readonly HostProcess[]): Set<number> {
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const chain = new Set<number>();
  for (let cursor = pid; cursor > 0 && !chain.has(cursor); cursor = byPid.get(cursor)?.ppid ?? 0) {
    chain.add(cursor);
  }
  return chain;
}

/**
 * Parses the standalone CLI's argv into oracle options, refusing the invocation
 * the type system already refuses in code: `--phase after-close` without a
 * `--closed-session` would accept every open capture handle and report clean.
 */
function parseDaemonLeakOracleArgs(argv: readonly string[]): DaemonLeakOracleOptions {
  const readFlag = (name: string): string[] =>
    argv.flatMap((arg, index) => (arg === name && argv[index + 1] ? [argv[index + 1]!] : []));
  const stateDir = readFlag('--state-dir')[0];
  if (!stateDir) {
    throw new AppError('INVALID_ARGS', 'daemon leak oracle: --state-dir is required');
  }
  const common = {
    stateDir,
    daemonPids: readFlag('--daemon-pid').map(Number),
    ...(readFlag('--sessions-dir')[0] ? { sessionsDir: readFlag('--sessions-dir')[0] } : {}),
    settleMs: Number(readFlag('--settle-ms')[0] ?? DEFAULT_SETTLE_MS),
  };
  const phase = readFlag('--phase')[0] ?? 'after-shutdown';
  if (phase !== 'after-close') return { ...common, phase: 'after-shutdown' };
  const [first, ...rest] = readFlag('--closed-session');
  if (!first) {
    throw new AppError(
      'INVALID_ARGS',
      'daemon leak oracle: --phase after-close requires at least one --closed-session',
      {
        hint: 'Pass the closed session directory name (the basename of the session state dir). Without it the checkpoint would accept every unfinalized capture handle and report clean.',
      },
    );
  }
  return { ...common, phase: 'after-close', closedSessions: [first, ...rest] };
}

// Standalone use (red-proofs, manual triage):
//   node --experimental-strip-types test/integration/support/daemon-leak-oracle.ts \
//     --state-dir <dir> --daemon-pid <pid> [--daemon-pid <pid>…] \
//     [--phase after-shutdown | --phase after-close --closed-session <dir-name>…]
//     [--sessions-dir <dir>] [--settle-ms <n>]
// Prints the report and exits 1 on a leak.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const snapshot = await settleDaemonLeakSnapshot(parseDaemonLeakOracleArgs(process.argv.slice(2)));
  process.stdout.write(`${formatDaemonLeakReport(snapshot)}\n`);
  process.exitCode = hasDaemonLeaks(snapshot) ? 1 : 0;
}
