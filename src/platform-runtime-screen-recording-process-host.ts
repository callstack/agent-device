import type {
  HostCommandResult,
  ManagedProcessIdentity,
  ManagedProcessOwnership,
} from '@agent-device/contracts/platform-runtime-host';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { errorMessage } from '@agent-device/kernel/errors';
import {
  expandProcessTree,
  type HostProcessInfo,
  isProcessAlive,
  isProcessZombie,
  listHostProcesses,
  readProcessCommand,
  readProcessIdentityFacts,
  readProcessStartTime,
  signalPidsBestEffort,
  waitForProcessExit,
} from '@agent-device/host-kit/process';

const STOP_TIMEOUT_MS = 5_000;
const FORCE_STOP_TIMEOUT_MS = 2_000;
const PROCESS_TREE_TIMEOUT_MS = 5_000;
/**
 * Budget for the identity reads that decide whether a process may be signaled. They run off
 * the event loop and concurrently across the set, so a loaded host costs this much wall time
 * per stop instead of blocking every other session on it, and a refused stop is recoverable
 * while a signal to the wrong process is not.
 */
const OWNERSHIP_PROBE_TIMEOUT_MS = 5_000;

type ManagedScreenRecordingProcess = Readonly<{
  child: Readonly<{
    pid?: number;
    kill(signal?: NodeJS.Signals | number): boolean;
  }>;
  wait: Promise<HostCommandResult>;
}>;

export type ManagedProcessCommandMatcher = (
  persistedCommand: string,
  observedCommand: string,
) => boolean;

const exactCommandMatch: ManagedProcessCommandMatcher = (persisted, observed) =>
  persisted === observed;

export async function resolveManagedProcessIdentity(
  pid: number | undefined,
): Promise<ManagedProcessIdentity | undefined> {
  if (pid === undefined) return undefined;
  const [startTime, command] = await Promise.all([
    Promise.resolve(readProcessStartTime(pid)),
    Promise.resolve(readProcessCommand(pid)),
  ]);
  return startTime && command ? Object.freeze({ pid, startTime, command }) : undefined;
}

export async function resolveManagedProcessTree(
  root: ManagedProcessIdentity,
): Promise<readonly ManagedProcessIdentity[]> {
  const processes = await readHostProcessTree(root.pid);
  const tree = expandProcessTree([root.pid], processes);
  const markers = await Promise.all(
    tree.map(async (processInfo) => await resolveManagedProcessIdentity(processInfo.pid)),
  );
  const complete = markers.filter(
    (marker): marker is ManagedProcessIdentity => marker !== undefined,
  );
  return Object.freeze([root, ...complete.filter((marker) => marker.pid !== root.pid)]);
}

/**
 * The host process table, or nothing when it could not be read. Descendants are an
 * addition to the markers already persisted at start, so a host that cannot answer `ps`
 * costs a child process here rather than the whole recording.
 */
async function readHostProcessTree(rootPid: number): Promise<readonly HostProcessInfo[]> {
  try {
    return await listHostProcesses({ timeoutMs: PROCESS_TREE_TIMEOUT_MS });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'screen_recording_process_tree_unreadable',
      data: { rootPid, reason: errorMessage(error) },
    });
    return [];
  }
}

export function inspectManagedProcess(
  marker: ManagedProcessIdentity,
  commandMatches: ManagedProcessCommandMatcher = exactCommandMatch,
): ManagedProcessOwnership {
  if (!isProcessAlive(marker.pid) || isProcessZombie(marker.pid)) return 'missing';
  return markerMatches(marker, commandMatches) ? 'owned-alive' : 'ownership-lost';
}

/**
 * What the host says about one persisted marker. `unprovable` is kept apart from `not-ours`
 * because they license opposite actions: a `ps` the host was too loaded to answer says
 * nothing about who owns a live pid, while a `ps` that names a different process proves
 * this owner may signal it no more.
 */
type OwnershipEvidence = 'ours' | 'gone' | 'not-ours' | 'unprovable';

type MarkerInspection = Readonly<{
  marker: ManagedProcessIdentity;
  evidence: OwnershipEvidence;
}>;

async function readOwnershipEvidence(
  marker: ManagedProcessIdentity,
  commandMatches: ManagedProcessCommandMatcher,
): Promise<OwnershipEvidence> {
  if (!isProcessAlive(marker.pid)) return 'gone';
  const facts = await readProcessIdentityFacts(marker.pid, OWNERSHIP_PROBE_TIMEOUT_MS);
  if (facts.zombie === true) return 'gone';
  if (marker.startTime.length === 0 || marker.command.length === 0) return 'not-ours';
  if (facts.startTime === null || facts.command === null) return 'unprovable';
  if (facts.startTime !== marker.startTime) return 'not-ours';
  return commandMatches(marker.command, facts.command) ? 'ours' : 'not-ours';
}

export async function terminateManagedProcessSet(
  persisted: readonly ManagedProcessIdentity[],
  background?: ManagedScreenRecordingProcess,
  commandMatches: ManagedProcessCommandMatcher = exactCommandMatch,
): Promise<'terminated' | 'already-missing' | 'ownership-lost'> {
  // `child.kill` is Node's own handle, which stops reaching the pid once the child has
  // exited, so the process this owner spawned is the one pid it may signal while the host is
  // not answering. Every other marker needs the host to name it: `unprovable` is not
  // permission, and `not-ours` is a refusal that survives whatever the rest of the set says.
  const spawnedPid = background?.child.pid;
  const inspect = async (marker: ManagedProcessIdentity): Promise<MarkerInspection> => ({
    marker,
    evidence: await readOwnershipEvidence(marker, commandMatches),
  });
  const endable = ({ marker, evidence }: MarkerInspection): boolean =>
    evidence === 'ours' || (evidence === 'unprovable' && marker.pid === spawnedPid);

  const persistedEvidence = await Promise.all(persisted.map(inspect));
  const root = persistedEvidence[0];
  const persistedPids = new Set(persisted.map(({ pid }) => pid));
  const descendants =
    root !== undefined && endable(root) ? await resolveManagedProcessTree(root.marker) : [];
  const found = await Promise.all(
    descendants
      .filter(({ pid }) => !persistedPids.has(pid))
      .map(async (marker) => await inspect(marker)),
  );
  const set = [...persistedEvidence, ...found];
  const signalTargets = set.filter(endable).map(({ marker }) => marker);
  if (signalTargets.length === 0) {
    return outcomeWithoutSignalTargets(set.map(({ evidence }) => evidence));
  }
  // A live marker this owner may not end is evidence the set is not finished, even though
  // signaling it is not on the table; it is reported rather than waited out.
  const signaledPids = new Set(signalTargets.map(({ pid }) => pid));
  const leftBehind = set.filter(
    ({ marker, evidence }) => !signaledPids.has(marker.pid) && evidence !== 'gone',
  );
  for (const [signal, timeoutMs] of [
    ['SIGINT', STOP_TIMEOUT_MS],
    ['SIGTERM', FORCE_STOP_TIMEOUT_MS],
    ['SIGKILL', FORCE_STOP_TIMEOUT_MS],
  ] as const) {
    signalMarkerSet(signalTargets, signal, background);
    if (await markerSetExits(signalTargets, timeoutMs, background, commandMatches)) {
      return leftBehind.length === 0 ? 'terminated' : 'ownership-lost';
    }
  }
  return 'ownership-lost';
}

function outcomeWithoutSignalTargets(
  evidence: readonly OwnershipEvidence[],
): 'already-missing' | 'ownership-lost' {
  return evidence.every((value) => value === 'gone') ? 'already-missing' : 'ownership-lost';
}

function signalMarkerSet(
  markers: readonly ManagedProcessIdentity[],
  signal: NodeJS.Signals,
  background?: ManagedScreenRecordingProcess,
): void {
  const directPid = background?.child.pid;
  signalPidsBestEffort(
    markers.map(({ pid }) => pid).filter((pid) => pid !== directPid),
    signal,
  );
  if (directPid !== undefined && markers.some(({ pid }) => pid === directPid)) {
    background?.child.kill(signal);
  }
}

async function markerSetExits(
  markers: readonly ManagedProcessIdentity[],
  timeoutMs: number,
  background: ManagedScreenRecordingProcess | undefined,
  commandMatches: ManagedProcessCommandMatcher,
): Promise<boolean> {
  const directPid = background?.child.pid;
  const directSettled = background ? await settlesWithin(background.wait, timeoutMs) : false;
  await Promise.all(
    markers
      .filter(({ pid }) => !directSettled || pid !== directPid)
      .map(async ({ pid }) => await waitForProcessExit(pid, timeoutMs)),
  );
  return markers.every(
    (marker) =>
      (directSettled && marker.pid === directPid) ||
      inspectManagedProcess(marker, commandMatches) === 'missing',
  );
}

function markerMatches(
  marker: ManagedProcessIdentity,
  commandMatches: ManagedProcessCommandMatcher,
): boolean {
  const observedCommand = readProcessCommand(marker.pid);
  return (
    marker.startTime.length > 0 &&
    marker.command.length > 0 &&
    readProcessStartTime(marker.pid) === marker.startTime &&
    observedCommand !== null &&
    commandMatches(marker.command, observedCommand)
  );
}

async function settlesWithin(wait: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([
    wait.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
