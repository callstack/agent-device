// Daemon leak rules (#1781 B1, feeds #1431): given one observation of an
// isolated state dir and the daemon pids a lane observed, decide whether daemon
// lifecycle or durable state leaked. Pure — `daemon-leak-oracle.ts` gathers the
// observation and asserts on it; `daemon-leak-model.test.ts` pins the rules.
//
// Two leak classes:
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
import { uniquePositivePids } from '../../../src/utils/host-process.ts';

export type DaemonLeakPhase = 'after-close' | 'after-shutdown';

/** One state-dir path, pre-read so the rules stay free of filesystem access. */
export type StateEntry = {
  /** Relative to the state dir, `/`-separated; directories keep a trailing `/`. */
  path: string;
  kind: 'file' | 'empty-directory';
  /** `lifecycle` of a durable capture descriptor, when this entry is one. */
  descriptorLifecycle?: string;
};

export type NonEmpty<T> = readonly [T, ...T[]];

/**
 * The phase and the identity it needs, as one shape. An `after-close`
 * checkpoint that cannot name the sessions that closed cannot tell their
 * unfinalized capture handles from another session's legitimately live one, so
 * it would accept every open handle and certify nothing. The identity is
 * therefore part of the phase rather than an option a caller may omit, and the
 * typechecker refuses the empty case.
 */
export type DaemonLeakPhaseSelection =
  | { phase: 'after-shutdown' }
  | { phase: 'after-close'; closedSessions: NonEmpty<string> };

export type DaemonLeakObservationBase = {
  stateDir: string;
  daemonPids: readonly number[];
  livePids: readonly number[];
  stateEntries: readonly StateEntry[];
};

export type DaemonLeakObservation = DaemonLeakPhaseSelection & DaemonLeakObservationBase;

export type DaemonLeakSnapshot = {
  stateDir: string;
  daemonPids: number[];
  phase: DaemonLeakPhase;
  liveDaemonPids: number[];
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
    strayStateEntries: observation.stateEntries
      .filter(
        (entry) =>
          classifyStateEntry(entry, {
            phase: observation.phase,
            daemonLegitimatelyAlive,
            closedSessions: closedSessionsOf(observation),
          }) === 'stray',
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
  return survivingDaemonPids(snapshot).length > 0 || snapshot.strayStateEntries.length > 0;
}

function survivingDaemonPids(snapshot: DaemonLeakSnapshot): number[] {
  return snapshot.phase === 'after-shutdown' ? snapshot.liveDaemonPids : [];
}

type StateEntryContext = {
  phase: DaemonLeakPhase;
  daemonLegitimatelyAlive: boolean;
  closedSessions: readonly string[];
};

function classifyStateEntry(entry: StateEntry, context: StateEntryContext): 'expected' | 'stray' {
  if (MANAGED_TOOLS_ENTRY.test(entry.path)) return 'expected';
  if (entry.kind === 'empty-directory') return 'stray';
  if (entry.path.endsWith('.tmp')) return 'stray';
  if (DAEMON_LIVENESS_ENTRY.test(entry.path)) {
    return context.daemonLegitimatelyAlive ? 'expected' : 'stray';
  }
  if (CAPTURE_DESCRIPTOR_ENTRY.test(entry.path) || LEGACY_APP_LOG_MARKER_ENTRY.test(entry.path)) {
    return classifyCaptureEntry(entry, context);
  }
  return EXPECTED_STATE_DIR_ENTRIES.some((matcher) => matcher.test(entry.path))
    ? 'expected'
    : 'stray';
}

// A capture handle must be finalized once its owning session is gone: after
// shutdown that is every session, after close only the sessions that closed.
// Another session's live capture stays expected, and a legacy pid marker is
// never a finish record, so it is stray whenever its session is gone.
function classifyCaptureEntry(entry: StateEntry, context: StateEntryContext): 'expected' | 'stray' {
  const owningSessionGone =
    context.phase === 'after-shutdown' ||
    context.closedSessions.includes(sessionDirectoryOf(entry.path) ?? '');
  if (!owningSessionGone) return 'expected';
  if (!CAPTURE_DESCRIPTOR_ENTRY.test(entry.path)) return 'stray';
  return entry.descriptorLifecycle === 'completed' ? 'expected' : 'stray';
}

function closedSessionsOf(observation: DaemonLeakObservation): readonly string[] {
  return observation.phase === 'after-close' ? observation.closedSessions : [];
}

function sessionDirectoryOf(entryPath: string): string | undefined {
  return /^sessions\/([^/]+)\//.exec(entryPath)?.[1];
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
    `  stray state-dir entries: ${snapshot.strayStateEntries.length}`,
    ...snapshot.strayStateEntries.map((entry) => `    ${entry}`),
  ].join('\n');
}

function formatPids(pids: readonly number[]): string {
  return pids.join(', ') || '(none)';
}
