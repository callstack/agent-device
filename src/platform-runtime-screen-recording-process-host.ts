import type {
  HostCommandResult,
  ManagedProcessIdentity,
  ManagedProcessOwnership,
} from '@agent-device/contracts/platform-runtime-host';
import {
  expandProcessTree,
  isProcessAlive,
  isProcessZombie,
  listHostProcesses,
  readProcessCommand,
  readProcessStartTime,
  signalPidsBestEffort,
  waitForProcessExit,
} from './utils/host-process.ts';

const STOP_TIMEOUT_MS = 5_000;
const FORCE_STOP_TIMEOUT_MS = 2_000;
const PROCESS_LIST_TIMEOUT_MS = 1_000;

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
  const processes = await listHostProcesses({ timeoutMs: PROCESS_LIST_TIMEOUT_MS });
  const tree = expandProcessTree([root.pid], processes);
  const markers = await Promise.all(
    tree.map(async (processInfo) => await resolveManagedProcessIdentity(processInfo.pid)),
  );
  const complete = markers.filter(
    (marker): marker is ManagedProcessIdentity => marker !== undefined,
  );
  return Object.freeze([root, ...complete.filter((marker) => marker.pid !== root.pid)]);
}

export function inspectManagedProcess(
  marker: ManagedProcessIdentity,
  commandMatches: ManagedProcessCommandMatcher = exactCommandMatch,
): ManagedProcessOwnership {
  if (!isProcessAlive(marker.pid) || isProcessZombie(marker.pid)) return 'missing';
  return markerMatches(marker, commandMatches) ? 'owned-alive' : 'ownership-lost';
}

export async function terminateManagedProcessSet(
  persisted: readonly ManagedProcessIdentity[],
  background?: ManagedScreenRecordingProcess,
  commandMatches: ManagedProcessCommandMatcher = exactCommandMatch,
): Promise<'terminated' | 'already-missing' | 'ownership-lost'> {
  const inspected = persisted.map((marker) => ({
    marker,
    ownership: inspectManagedProcess(marker, commandMatches),
  }));
  if (inspected.some(({ ownership }) => ownership === 'ownership-lost')) {
    return 'ownership-lost';
  }
  const live = inspected
    .filter(({ ownership }) => ownership === 'owned-alive')
    .map(({ marker }) => marker);
  if (live.length === 0) return 'already-missing';
  const root = persisted[0];
  const expanded =
    root && inspectManagedProcess(root, commandMatches) === 'owned-alive'
      ? await resolveManagedProcessTree(root)
      : [];
  const markers = uniqueMarkers([...live, ...expanded]);
  if (
    markers.some((marker) => inspectManagedProcess(marker, commandMatches) === 'ownership-lost')
  ) {
    return 'ownership-lost';
  }
  for (const [signal, timeoutMs] of [
    ['SIGINT', STOP_TIMEOUT_MS],
    ['SIGTERM', FORCE_STOP_TIMEOUT_MS],
    ['SIGKILL', FORCE_STOP_TIMEOUT_MS],
  ] as const) {
    signalMarkerSet(markers, signal, background);
    if (await markerSetExits(markers, timeoutMs, background?.wait, commandMatches)) {
      return 'terminated';
    }
  }
  return 'ownership-lost';
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
  directWait?: Promise<HostCommandResult>,
  commandMatches: ManagedProcessCommandMatcher = exactCommandMatch,
): Promise<boolean> {
  const directPid = markers[0]?.pid;
  const directSettled = directWait ? await settlesWithin(directWait, timeoutMs) : false;
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

function uniqueMarkers(
  markers: readonly ManagedProcessIdentity[],
): readonly ManagedProcessIdentity[] {
  return [...new Map(markers.map((marker) => [marker.pid, marker])).values()];
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
