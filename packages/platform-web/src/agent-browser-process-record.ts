import crypto from 'node:crypto';
import path from 'node:path';
import type { OwnedProcessRecord } from '@agent-device/contracts/platform-runtime-host';
import { uniqueStrings } from '@agent-device/kernel/collections';
import { withoutCommandExecutorOverride } from '@agent-device/host-kit/command';
import {
  expandProcessTree,
  hostProcessId,
  listHostProcesses,
  readHostProcessIdentityObservationsAsync,
  readProcessCommand,
  readProcessStartTime,
  type HostProcessInfo,
  type OwnedProcessRecordStore,
} from '@agent-device/host-kit/process';

import type { AgentBrowserToolStatus } from './agent-browser-tool.ts';

const HOST_PROCESS_LIST_TIMEOUT_MS = 1_500;
const AGENT_DEVICE_BROWSER_MARKER_PREFIX = '--agent-device-managed-web=';

/** The `purpose` every owned-process record for the managed web fleet carries. */
export const MANAGED_WEB_BROWSER_PROCESS_PURPOSE = 'managed-web-browser';

export type AgentBrowserProcessMatch = {
  process: HostProcessInfo;
  reason: 'agent-browser-daemon' | 'launch-marker' | 'managed-browser-home' | 'descendant';
};

export type AgentBrowserProcessSummary = {
  count: number;
  pids: number[];
  processes: AgentBrowserProcessMatch[];
};

export function agentBrowserChromeLaunchMarker(status: AgentBrowserToolStatus): string {
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

export function matchAgentBrowserChromeProcess(
  processInfo: HostProcessInfo,
  status: AgentBrowserToolStatus,
): AgentBrowserProcessMatch | undefined {
  if (processInfo.pid === hostProcessId() || !isChromeLikeCommand(processInfo.command))
    return undefined;
  if (processInfo.command.includes(agentBrowserChromeLaunchMarker(status))) {
    return { process: processInfo, reason: 'launch-marker' };
  }
  if (managedBrowserHomeMarkers(status).some((marker) => isCommandUnderPath(processInfo, marker))) {
    return { process: processInfo, reason: 'managed-browser-home' };
  }
  return undefined;
}

export function summarizeAgentBrowserProcesses(
  processes: HostProcessInfo[],
  status: AgentBrowserToolStatus,
): AgentBrowserProcessSummary {
  return summarizeMatches(processes, (processInfo) =>
    matchAgentBrowserChromeProcess(processInfo, status),
  );
}

function matchManagedAgentBrowserProcess(
  processInfo: HostProcessInfo,
  status: AgentBrowserToolStatus,
): AgentBrowserProcessMatch | undefined {
  return (
    matchAgentBrowserChromeProcess(processInfo, status) ??
    matchAgentBrowserDaemonProcess(processInfo, status)
  );
}

export function summarizeManagedAgentBrowserProcesses(
  processes: HostProcessInfo[],
  status: AgentBrowserToolStatus,
): AgentBrowserProcessSummary {
  return summarizeMatches(processes, (processInfo) =>
    matchManagedAgentBrowserProcess(processInfo, status),
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
): Promise<AgentBrowserProcessSummary> {
  const processes = await listRealHostProcesses();
  const roots = summarizeManagedAgentBrowserProcesses(processes, status);
  const ownedProcesses = expandProcessTree(roots.pids, processes);
  const summary: AgentBrowserProcessSummary = {
    count: ownedProcesses.length,
    pids: ownedProcesses.map(({ pid }) => pid),
    processes: ownedProcesses.map((process) => ({
      process,
      reason: matchManagedAgentBrowserProcess(process, status)?.reason ?? 'descendant',
    })),
  };
  const records: OwnedProcessRecord[] = summary.processes.flatMap(({ process: processInfo }) => {
    const startTime = readProcessStartTime(processInfo.pid);
    const command = readProcessCommand(processInfo.pid);
    return startTime && command
      ? [{ pid: processInfo.pid, startTime, command, purpose: MANAGED_WEB_BROWSER_PROCESS_PURPOSE }]
      : [];
  });
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
  const records = readDaemonManagedWebBrowserRecords(store);
  if (records.length === 0) return false;
  const observations = await readHostProcessIdentityObservationsAsync(
    records.map((record) => record.pid),
  );
  return records.every((record) => {
    const observation = observations.get(record.pid);
    return (
      observation !== undefined &&
      !observation.state.startsWith('Z') &&
      observation.startTime === record.startTime
    );
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

function matchAgentBrowserDaemonProcess(
  processInfo: HostProcessInfo,
  status: AgentBrowserToolStatus,
): AgentBrowserProcessMatch | undefined {
  if (processInfo.pid === hostProcessId() || isChromeLikeCommand(processInfo.command))
    return undefined;
  const command = normalizePathSeparators(processInfo.command);
  const installDir = normalizePathSeparators(path.resolve(status.installDir));
  return command.includes(`${installDir}/`)
    ? { process: processInfo, reason: 'agent-browser-daemon' }
    : undefined;
}

function managedBrowserHomeMarkers(status: AgentBrowserToolStatus): string[] {
  return uniqueStrings([
    path.join(status.homeDir, '.agent-browser', 'browsers'),
    path.join(status.runtimeHomeDir, '.agent-browser', 'browsers'),
  ]);
}

function isCommandUnderPath(processInfo: HostProcessInfo, rootPath: string): boolean {
  const command = normalizePathSeparators(processInfo.command);
  const root = `${normalizePathSeparators(path.resolve(rootPath)).replace(/\/+$/, '')}/`;
  return command.includes(root);
}

function normalizePathSeparators(value: string): string {
  return value.replaceAll('\\', '/');
}
