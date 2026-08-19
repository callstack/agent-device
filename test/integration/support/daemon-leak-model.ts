// Daemon leak rules (#1781 B1, feeds #1431): given one observation of the host
// process table and of an isolated state dir, decide what the daemon still owns.
// Pure — `daemon-leak-oracle.ts` gathers the observation and asserts on it, and
// `daemon-leak-model.test.ts` pins these rules against fixture observations,
// including the #1109 and #1324 leak shapes.
//
// Ownership is explicit and conservative. Global process counts are not
// evidence — the simulator, XCTest, and Chrome-for-Testing own processes this
// daemon does not. A host process is daemon-owned when ANY rule holds:
//
//   descendant     its PPID chain reaches a daemon pid, or any process already
//                  owned below (observable while that ancestor lives; orphans
//                  reparent to launchd/init).
//   process-group  its PGID equals a daemon pid. The CLI launches the daemon
//                  detached (setsid), so the daemon is its own group leader and
//                  every non-detached runCmdBackground child stays in that group
//                  after reparenting. This is the #1324 signature: `simctl io …
//                  recordVideo` with PPID 1 and PGID = the dead daemon's pid.
//                  A pgid is reserved only while the group has a live member, so
//                  on a long-lived host pid reuse can eventually hand the number
//                  to an unrelated process; the lanes' state dirs are fresh per
//                  run, and every red-proof cross-checks the command line.
//   state-dir-env  its environment carries AGENT_DEVICE_STATE_DIR=<state dir>.
//                  The CLI starts the daemon with that variable and children
//                  inherit it, including setsid'd grandchildren the pgid rule
//                  misses (agent-browser's own daemon → Chrome fleet: #1109).
//                  macOS hides the environment of Apple platform binaries
//                  (`ps -E` shows it for node/Chrome, not for /bin/sleep or
//                  simctl), so Apple tooling is caught by the pgid/argv rules.
//   state-dir-argv its command line contains the state dir path as a whole path
//                  token (recorders writing session artifacts, browsers pinned
//                  to a managed home).
//
// The lanes use a fresh mkdtemp state dir per run, so the env/argv rules cannot
// match a foreign process. The caller excludes itself and its own ancestors.
//
// Two further leak classes, independent of owned children:
//
//   surviving daemon   at `after-shutdown` a daemon pid that is still alive IS
//                      the leak. `stopProcessForTakeover` is best-effort and
//                      returns silently on identity mismatch, signal failure, or
//                      kill timeout, so a lane that only stops the daemon never
//                      learns it survived.
//   state-dir residue  every entry must match EXPECTED_STATE_DIR_ENTRIES
//                      (unknown ⇒ classify the new artifact, do not widen the
//                      matcher): `*.tmp` write-then-publish temporaries are torn
//                      publishes, an empty directory is an unswept session
//                      scaffold, daemon.json/daemon.lock may exist only while a
//                      daemon legitimately lives, and a capture descriptor still
//                      `lifecycle: "open"` (or a legacy `app-log.pid` marker)
//                      after shutdown is a capture handle that outlived its
//                      owner — a `completed` descriptor is the finish record
//                      ADR 0019 keeps. `tools/` holds managed third-party
//                      installs (agent-browser and its Chrome), whose own
//                      download temporaries and scaffolding this daemon neither
//                      writes nor owns.
import { expandProcessTree, uniquePositivePids } from '../../../src/utils/host-process.ts';

const COMMAND_PREVIEW_CHARS = 160;

export type DaemonLeakPhase = 'after-close' | 'after-shutdown';

export type OwnershipReason = 'descendant' | 'process-group' | 'state-dir-env' | 'state-dir-argv';

export type HostProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
  /** Environment as a single string; empty when the host hides it. */
  env: string;
};

/** One state-dir path, pre-read so the rules stay free of filesystem access. */
export type StateEntry = {
  /** Relative to the state dir, `/`-separated; directories keep a trailing `/`. */
  path: string;
  kind: 'file' | 'empty-directory';
  /** `lifecycle` of a durable capture descriptor, when this entry is one. */
  descriptorLifecycle?: string;
};

export type OwnedProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
  reasons: OwnershipReason[];
};

export type DaemonLeakObservation = {
  stateDir: string;
  daemonPids: readonly number[];
  livePids: readonly number[];
  phase: DaemonLeakPhase;
  processes: readonly HostProcess[];
  /** Pids never treated as owned: the observer and its own ancestors. */
  excludedPids: readonly number[];
  stateEntries: readonly StateEntry[];
};

export type DaemonLeakSnapshot = {
  stateDir: string;
  daemonPids: number[];
  phase: DaemonLeakPhase;
  liveDaemonPids: number[];
  ownedProcesses: OwnedProcess[];
  strayStateEntries: string[];
};

// `tools/` is a managed third-party install tree (agent-browser + Chrome), not
// daemon write-then-publish output, so it is exempted before the generic rules.
const MANAGED_TOOLS_ENTRY = /^tools\//;
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
  /^device-claims\/.+$/,
];
const CAPTURE_DESCRIPTOR_ENTRY = /^sessions\/[^/]+\/[^/]+\.resource\.json$/;
const LEGACY_APP_LOG_MARKER_ENTRY = /^sessions\/[^/]+\/app-log\.pid$/;
const DAEMON_LIVENESS_ENTRY = /^daemon\.(?:json|lock)$/;

export function evaluateDaemonLeaks(observation: DaemonLeakObservation): DaemonLeakSnapshot {
  const daemonPids = uniquePositivePids(observation.daemonPids);
  const liveDaemonPids = daemonPids.filter((pid) => observation.livePids.includes(pid));
  const daemonLegitimatelyAlive = observation.phase === 'after-close' && liveDaemonPids.length > 0;
  return {
    stateDir: observation.stateDir,
    daemonPids,
    phase: observation.phase,
    liveDaemonPids,
    ownedProcesses: findOwnedProcesses(observation, daemonPids),
    strayStateEntries: observation.stateEntries
      .filter(
        (entry) =>
          classifyStateEntry(entry, observation.phase, daemonLegitimatelyAlive) === 'stray',
      )
      .map((entry) => entry.path)
      .sort(),
  };
}

/**
 * A daemon that outlived its own shutdown is itself the leak — not a detail of
 * the report — so it fails alongside owned children and state-dir residue.
 */
export function hasDaemonLeaks(snapshot: DaemonLeakSnapshot): boolean {
  return (
    survivingDaemonPids(snapshot).length > 0 ||
    snapshot.ownedProcesses.length > 0 ||
    snapshot.strayStateEntries.length > 0
  );
}

function survivingDaemonPids(snapshot: DaemonLeakSnapshot): number[] {
  return snapshot.phase === 'after-shutdown' ? snapshot.liveDaemonPids : [];
}

function findOwnedProcesses(
  observation: DaemonLeakObservation,
  daemonPids: readonly number[],
): OwnedProcess[] {
  const excluded = new Set([...observation.excludedPids, ...daemonPids]);
  const matchers = stateDirMatchers(observation.stateDir);
  const reasonsByPid = new Map<number, OwnershipReason[]>();
  for (const proc of observation.processes) {
    if (excluded.has(proc.pid)) continue;
    const reasons = directOwnershipReasons(proc, daemonPids, matchers);
    if (reasons.length > 0) reasonsByPid.set(proc.pid, reasons);
  }
  // Ownership propagates down the tree: a child of the daemon, or of any process
  // the rules above own, is owned (a detached `(simctl)` grandchild of a leaked
  // recorder shim, DTServiceHub under a runner xcodebuild, …).
  const roots = [...daemonPids, ...reasonsByPid.keys()];
  for (const proc of expandProcessTree(roots, observation.processes)) {
    if (excluded.has(proc.pid) || roots.includes(proc.pid)) continue;
    reasonsByPid.set(proc.pid, [...(reasonsByPid.get(proc.pid) ?? []), 'descendant']);
  }
  return observation.processes.flatMap((proc) => {
    const reasons = reasonsByPid.get(proc.pid);
    return reasons
      ? [{ pid: proc.pid, ppid: proc.ppid, pgid: proc.pgid, command: proc.command, reasons }]
      : [];
  });
}

type StateDirMatchers = { argv: RegExp; env: RegExp };

function stateDirMatchers(stateDir: string): StateDirMatchers {
  // Whole-path matches only: `<dir>` as a token or `<dir>/…`, never `<dir>-sibling`.
  return {
    argv: new RegExp(`(?:^|[\\s=])${escapeRegExp(stateDir)}(?:[\\s/]|$)`),
    env: new RegExp(`AGENT_DEVICE_STATE_DIR=${escapeRegExp(stateDir)}(?:\\s|$)`),
  };
}

function directOwnershipReasons(
  proc: HostProcess,
  daemonPids: readonly number[],
  matchers: StateDirMatchers,
): OwnershipReason[] {
  const reasons: OwnershipReason[] = [];
  if (daemonPids.includes(proc.pgid)) reasons.push('process-group');
  if (matchers.env.test(proc.env)) reasons.push('state-dir-env');
  if (matchers.argv.test(proc.command)) reasons.push('state-dir-argv');
  return reasons;
}

function classifyStateEntry(
  entry: StateEntry,
  phase: DaemonLeakPhase,
  daemonLegitimatelyAlive: boolean,
): 'expected' | 'stray' {
  if (MANAGED_TOOLS_ENTRY.test(entry.path)) return 'expected';
  if (entry.kind === 'empty-directory') return 'stray';
  if (entry.path.endsWith('.tmp')) return 'stray';
  if (DAEMON_LIVENESS_ENTRY.test(entry.path)) {
    return daemonLegitimatelyAlive ? 'expected' : 'stray';
  }
  if (CAPTURE_DESCRIPTOR_ENTRY.test(entry.path) || LEGACY_APP_LOG_MARKER_ENTRY.test(entry.path)) {
    return classifyCaptureEntry(entry, phase);
  }
  return EXPECTED_STATE_DIR_ENTRIES.some((matcher) => matcher.test(entry.path))
    ? 'expected'
    : 'stray';
}

// Another session may still hold a live capture while this one closes; after
// shutdown only a completed capture record may remain (never a pid marker).
function classifyCaptureEntry(entry: StateEntry, phase: DaemonLeakPhase): 'expected' | 'stray' {
  if (phase === 'after-close') return 'expected';
  if (!CAPTURE_DESCRIPTOR_ENTRY.test(entry.path)) return 'stray';
  return entry.descriptorLifecycle === 'completed' ? 'expected' : 'stray';
}

export function formatDaemonLeakReport(snapshot: DaemonLeakSnapshot): string {
  const surviving = survivingDaemonPids(snapshot);
  return [
    `daemon leak oracle: ${hasDaemonLeaks(snapshot) ? 'LEAK' : 'clean'} (${snapshot.phase})`,
    `  state dir: ${snapshot.stateDir}`,
    `  daemon pids: ${formatPids(snapshot.daemonPids)}; live: ${formatPids(snapshot.liveDaemonPids)}`,
    `  daemons that outlived shutdown: ${surviving.length}${
      surviving.length > 0 ? ` (${formatPids(surviving)})` : ''
    }`,
    `  owned processes still alive: ${snapshot.ownedProcesses.length}`,
    ...snapshot.ownedProcesses.map(
      (proc) =>
        `    pid ${proc.pid} ppid ${proc.ppid} pgid ${proc.pgid} [${proc.reasons.join(',')}] ${previewCommand(
          proc.command,
          snapshot.stateDir,
        )}`,
    ),
    `  stray state-dir entries: ${snapshot.strayStateEntries.length}`,
    ...snapshot.strayStateEntries.map((entry) => `    ${entry}`),
  ].join('\n');
}

function previewCommand(command: string, stateDir: string): string {
  const masked = command.replace(
    new RegExp(`${escapeRegExp(stateDir)}(?=[\\s/]|$)`, 'g'),
    '<state-dir>',
  );
  return masked.length > COMMAND_PREVIEW_CHARS
    ? `${masked.slice(0, COMMAND_PREVIEW_CHARS)}…`
    : masked;
}

function formatPids(pids: readonly number[]): string {
  return pids.join(', ') || '(none)';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
