import type { HostEnvironment } from '@agent-device/kernel/source-value';
import crypto from 'node:crypto';
import path from 'node:path';
import type { OwnedProcessRecord } from '@agent-device/contracts/platform-runtime-host';
import { uniqueStrings } from '@agent-device/kernel/collections';
import { hostFileStatSync, realHostPathSync } from '@agent-device/host-kit/host-file';
import { withoutCommandExecutorOverride } from '@agent-device/host-kit/command';
import {
  expandProcessTree,
  hostProcessId,
  hostPlatform,
  isProcessAlive,
  listHostProcesses,
  readHostProcessIdentityObservationsAsync,
  readProcessIdentities,
  readProcessExecutablePaths,
  type HostProcessInfo,
  type OwnedProcessRecordStore,
} from '@agent-device/host-kit/process';

import {
  listManagedInstallPaths,
  type ManagedInstallPaths,
} from './agent-browser-install-paths.ts';
import type { AgentBrowserToolStatus } from './agent-browser-tool.ts';

const HOST_PROCESS_LIST_TIMEOUT_MS = 1_500;
const AGENT_DEVICE_BROWSER_MARKER_PREFIX = '--agent-device-managed-web=';

/** The `purpose` every owned-process record for the managed web fleet carries. */
export const MANAGED_WEB_BROWSER_PROCESS_PURPOSE = 'verified-managed-web-browser';

export type AgentBrowserProcessMatch = {
  process: HostProcessInfo;
  reason: 'agent-browser-daemon' | 'launch-marker' | 'managed-browser-home' | 'descendant';
};

export type AgentBrowserProcessSummary = {
  count: number;
  pids: number[];
  processes: AgentBrowserProcessMatch[];
};

export function agentBrowserChromeLaunchMarker(
  status: Pick<ManagedInstallPaths, 'stateDir' | 'installDir'>,
): string {
  const hash = crypto.createHash('sha256');
  hash.update(path.resolve(status.stateDir));
  hash.update('\0');
  hash.update(path.resolve(status.installDir));
  return `${AGENT_DEVICE_BROWSER_MARKER_PREFIX}${hash.digest('hex').slice(0, 16)}`;
}

export function appendAgentDeviceChromeArgs(
  existingArgs: string | undefined,
  status: AgentBrowserToolStatus,
): string {
  const marker = agentBrowserChromeLaunchMarker(status);
  const existing = existingArgs?.trim();
  if (!existing) return marker;
  if (splitAgentBrowserArgs(existing).includes(marker)) return existing;
  return `${existing},${marker}`;
}

export function summarizeAgentBrowserProcesses(
  processes: HostProcessInfo[],
  status: AgentBrowserToolStatus,
): AgentBrowserProcessSummary {
  const ownership = managedFleetOwnership(status);
  return summarizeMatches(processes, (processInfo) => matchChromeProcess(processInfo, ownership));
}

function matchManagedAgentBrowserProcess(
  processInfo: HostProcessInfo,
  ownership: ManagedFleetOwnership,
  executablePath: string | undefined,
): AgentBrowserProcessMatch | undefined {
  if (!executablePath || processInfo.pid === hostProcessId()) return undefined;
  const executable = normalizePathSeparators(executablePath);
  if (
    isChromeExecutable(executable) &&
    ownership.launchMarkers.some((marker) => processInfo.command.includes(marker))
  ) {
    return { process: processInfo, reason: 'launch-marker' };
  }
  if (isManagedBrowserExecutable(executable, ownership.browserExecutableRoots)) {
    return { process: processInfo, reason: 'managed-browser-home' };
  }
  if (matchesManagedDaemonExecutable(executable, ownership.daemonEntries)) {
    return { process: processInfo, reason: 'agent-browser-daemon' };
  }
  return undefined;
}

function isManagedBrowserExecutable(executable: string, roots: readonly string[]): boolean {
  let resolvedExecutable: string;
  try {
    resolvedExecutable = normalizePathSeparators(realHostPathSync(executable));
  } catch {
    return false;
  }
  return roots.some((root) => resolvedExecutable.startsWith(`${root}/`));
}

function matchesManagedDaemonExecutable(executable: string, entries: readonly string[]): boolean {
  if (entries.includes(executable)) return true;
  if (hostPlatform() !== 'win32') return false;
  const entry = entries.find((candidate) => candidate.toLowerCase() === executable.toLowerCase());
  if (!entry) return false;
  try {
    const expected = hostFileStatSync(entry);
    const observed = hostFileStatSync(executable);
    return (
      Number.isSafeInteger(expected.ino) &&
      expected.ino > 0 &&
      Number.isSafeInteger(expected.dev) &&
      expected.ino === observed.ino &&
      expected.dev === observed.dev
    );
  } catch {
    return false;
  }
}

function isChromeExecutable(executable: string): boolean {
  const name = executable.slice(executable.lastIndexOf('/') + 1);
  return /^(?:Google Chrome(?: for Testing)?|Chrome for Testing|Chromium|chrome(?:\.exe)?|chromium|chromium-browser|headless_shell)$/i.test(
    name,
  );
}

export async function inspectManagedAgentBrowserProcesses(
  status: AgentBrowserToolStatus,
): Promise<AgentBrowserProcessSummary> {
  return summarizeAgentBrowserProcesses(await listRealHostProcesses(), status);
}

export async function recordManagedAgentBrowserProcesses(
  status: AgentBrowserToolStatus,
  store: OwnedProcessRecordStore,
  host: HostEnvironment,
): Promise<AgentBrowserProcessSummary> {
  const initial = await listRealHostProcesses();
  const pids = initial.map(({ pid }) => pid);
  const before = await readProcessIdentities(pids);
  const scanned = await listRealHostProcesses();
  const executablePaths = await readProcessExecutablePaths(pids, host);
  const after = await readProcessIdentities(pids);
  const initialPids = new Set(pids);
  const processes = scanned.filter(({ pid, command }) => {
    const first = before.get(pid);
    const last = after.get(pid);
    return (
      initialPids.has(pid) &&
      !!first?.startTime &&
      !!first.command &&
      first.zombie === false &&
      last?.zombie === false &&
      first.startTime === last.startTime &&
      first.command === last.command &&
      command === first.command
    );
  });
  const ownership = managedFleetOwnership(status);
  const roots = summarizeMatches(processes, (processInfo) =>
    matchManagedAgentBrowserProcess(processInfo, ownership, executablePaths.get(processInfo.pid)),
  );
  const ownedProcesses = expandProcessTree(roots.pids, processes);
  const summary: AgentBrowserProcessSummary = {
    count: ownedProcesses.length,
    pids: ownedProcesses.map(({ pid }) => pid),
    processes: ownedProcesses.map((processInfo) => ({
      process: processInfo,
      reason:
        matchManagedAgentBrowserProcess(
          processInfo,
          ownership,
          executablePaths.get(processInfo.pid),
        )?.reason ?? 'descendant',
    })),
  };
  const records: OwnedProcessRecord[] = ownedProcesses.map(({ pid, command }) => ({
    pid,
    startTime: before.get(pid)!.startTime!,
    command,
    purpose: MANAGED_WEB_BROWSER_PROCESS_PURPOSE,
  }));
  if (records.length > 0) store.replace({ kind: 'daemon' }, records);
  return summary;
}

/**
 * Whether the daemon-scoped record still describes a live managed fleet.
 *
 * `true` only when every process the record names is alive under the identity the record carries:
 * named by one same-pid snapshot, not a zombie, started at the recorded time. Unknown evidence —
 * an unanswered probe, an undecodable or empty record — reads as not-live, so the caller rescans
 * and re-owns. This vouches for the recorded pids, not for fleet membership: a browser child the
 * fleet minted after the last scan stays unrecorded, and dies with the recorded browser process
 * that parents it. Liveness-and-lifetime is the whole question here; the reaper that signals
 * proves identity per pid with its own facts.
 */
export async function managedWebBrowserProcessRecordIsLive(
  store: OwnedProcessRecordStore,
): Promise<boolean> {
  const liveness = await readRecordedProcessLiveness(store);
  return liveness.length > 0 && liveness.every((state) => state === 'alive');
}

/**
 * Whether the daemon-scoped record names processes and every one of them was observed not alive:
 * gone, a zombie, or under another start time than the record carries. An empty, undecodable, or
 * unanswered record, or a process the probe could not observe, is unknown evidence, not dead.
 */
export async function managedWebBrowserProcessRecordIsDead(
  store: OwnedProcessRecordStore,
): Promise<boolean> {
  const liveness = await readRecordedProcessLiveness(store);
  return liveness.length > 0 && liveness.every((state) => state === 'not-alive');
}

type RecordedProcessLiveness = 'alive' | 'not-alive' | 'unobserved';

async function readRecordedProcessLiveness(
  store: OwnedProcessRecordStore,
): Promise<readonly RecordedProcessLiveness[]> {
  const records = readDaemonManagedWebBrowserRecords(store);
  if (records.length === 0) return [];
  const observations = await readHostProcessIdentityObservationsAsync(
    records.map((record) => record.pid),
  );
  return records.map((record) => {
    const observation = observations.get(record.pid);
    // A pid the process table does not name is gone only when the signal probe agrees; a table
    // that answered nothing (a failed `ps`) leaves it unobserved.
    if (observation === undefined) return isProcessAlive(record.pid) ? 'unobserved' : 'not-alive';
    return !observation.state.startsWith('Z') && observation.startTime === record.startTime
      ? 'alive'
      : 'not-alive';
  });
}

/**
 * The daemon-scoped managed browser records. A store that cannot answer has none, which is
 * unknown evidence: the probe reports not-live and the caller re-derives by scanning.
 */
function readDaemonManagedWebBrowserRecords(store: OwnedProcessRecordStore): OwnedProcessRecord[] {
  let entries: ReturnType<OwnedProcessRecordStore['read']>;
  try {
    entries = store.read();
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.scope.kind === 'daemon' && entry.status === 'decoded')
    .flatMap((entry) => entry.records)
    .filter((record) => record.purpose === MANAGED_WEB_BROWSER_PROCESS_PURPOSE);
}

async function listRealHostProcesses(): Promise<HostProcessInfo[]> {
  return await withoutCommandExecutorOverride(
    async () => await listHostProcesses({ timeoutMs: HOST_PROCESS_LIST_TIMEOUT_MS }),
  );
}

function summarizeMatches(
  processes: HostProcessInfo[],
  match: (processInfo: HostProcessInfo) => AgentBrowserProcessMatch | undefined,
): AgentBrowserProcessSummary {
  const matches = processes.flatMap((processInfo) => {
    const result = match(processInfo);
    return result ? [result] : [];
  });
  return {
    count: matches.length,
    pids: matches.map((entry) => entry.process.pid),
    processes: matches,
  };
}

function splitAgentBrowserArgs(args: string): string[] {
  return args
    .split(/[,\n]/)
    .map((arg) => arg.trim())
    .filter(Boolean);
}

function isChromeLikeCommand(command: string): boolean {
  return /\b(?:Google Chrome for Testing|Chrome for Testing|Chromium|chrome|chrome\.exe|chromium|chromium-browser|headless_shell)\b/i.test(
    command,
  );
}

/**
 * What marks a process as part of the managed fleet: the current install plus every sibling
 * version directory under the same state dir, so a fleet left running by a previous pin still
 * matches after an upgrade moves the current install.
 */
type ManagedFleetOwnership = {
  launchMarkers: string[];
  browserHomeRoots: string[];
  browserExecutableRoots: string[];
  daemonEntries: string[];
};

function managedFleetOwnership(status: AgentBrowserToolStatus): ManagedFleetOwnership {
  const siblings = listManagedInstallPaths(status.stateDir).filter(
    (install) => path.resolve(install.installDir) !== path.resolve(status.installDir),
  );
  const installs: ManagedInstallPaths[] = [status, ...siblings];
  const browserHomeRoots = uniqueStrings(installs.flatMap(managedBrowserHomeMarkers));
  return {
    launchMarkers: installs.map(agentBrowserChromeLaunchMarker),
    browserHomeRoots,
    browserExecutableRoots: uniqueStrings(
      browserHomeRoots.flatMap((root) => {
        try {
          return [normalizePathSeparators(realHostPathSync(root)).replace(/\/+$/, '')];
        } catch {
          return [];
        }
      }),
    ),
    daemonEntries: installs.flatMap((install) => {
      let installRoot: string;
      try {
        installRoot = normalizePathSeparators(realHostPathSync(install.installDir));
      } catch {
        return [];
      }
      const bin = path.join(install.installDir, 'package', 'node_modules', 'agent-browser', 'bin');
      return [
        'agent-browser-darwin-arm64',
        'agent-browser-darwin-x64',
        'agent-browser-linux-arm64',
        'agent-browser-linux-x64',
        'agent-browser-linux-musl-arm64',
        'agent-browser-linux-musl-x64',
        'agent-browser-win32-arm64.exe',
        'agent-browser-win32-x64.exe',
      ].flatMap((name) => {
        try {
          const executable = normalizePathSeparators(realHostPathSync(path.join(bin, name)));
          return executable.startsWith(`${installRoot}/`) ? [executable] : [];
        } catch {
          return [];
        }
      });
    }),
  };
}

function matchChromeProcess(
  processInfo: HostProcessInfo,
  ownership: ManagedFleetOwnership,
): AgentBrowserProcessMatch | undefined {
  if (processInfo.pid === hostProcessId() || !isChromeLikeCommand(processInfo.command))
    return undefined;
  if (ownership.launchMarkers.some((marker) => processInfo.command.includes(marker))) {
    return { process: processInfo, reason: 'launch-marker' };
  }
  if (ownership.browserHomeRoots.some((root) => isCommandUnderPath(processInfo, root))) {
    return { process: processInfo, reason: 'managed-browser-home' };
  }
  return undefined;
}

function managedBrowserHomeMarkers(
  status: Pick<ManagedInstallPaths, 'homeDir' | 'runtimeHomeDir'>,
): string[] {
  return [
    path.join(status.homeDir, '.agent-browser', 'browsers'),
    path.join(status.runtimeHomeDir, '.agent-browser', 'browsers'),
  ];
}

function isCommandUnderPath(processInfo: HostProcessInfo, rootPath: string): boolean {
  const command = normalizePathSeparators(processInfo.command);
  const root = `${normalizePathSeparators(path.resolve(rootPath)).replace(/\/+$/, '')}/`;
  return command.includes(root);
}

function normalizePathSeparators(value: string): string {
  return value.replaceAll('\\', '/');
}
