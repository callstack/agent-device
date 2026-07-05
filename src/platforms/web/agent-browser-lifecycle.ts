import crypto from 'node:crypto';
import path from 'node:path';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { runCmd } from '../../utils/exec.ts';
import { isProcessAlive, waitForProcessExit } from '../../utils/process-identity.ts';
import { sleep } from '../../utils/timeouts.ts';
import type { AgentBrowserToolStatus } from './agent-browser-tool.ts';

const HOST_PROCESS_LIST_TIMEOUT_MS = 1_500;
const WEB_BROWSER_REAP_TERM_TIMEOUT_MS = 1_500;
const WEB_BROWSER_REAP_KILL_TIMEOUT_MS = 1_000;
const AGENT_DEVICE_BROWSER_MARKER_PREFIX = '--agent-device-managed-web=';
export const DEFAULT_AGENT_BROWSER_IDLE_TIMEOUT_MS = 5 * 60_000;

export type HostProcessInfo = {
  pid: number;
  ppid?: number;
  command: string;
};

export type AgentBrowserProcessMatch = {
  process: HostProcessInfo;
  reason: 'launch-marker' | 'managed-browser-home';
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

export function resolveAgentBrowserIdleTimeoutMs(env: NodeJS.ProcessEnv): number {
  return (
    readPositiveInteger(env.AGENT_BROWSER_IDLE_TIMEOUT_MS) ??
    readPositiveInteger(env.AGENT_DEVICE_WEB_IDLE_TIMEOUT_MS) ??
    DEFAULT_AGENT_BROWSER_IDLE_TIMEOUT_MS
  );
}

export function parseHostProcessList(stdout: string): HostProcessInfo[] {
  const processes: HostProcessInfo[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const ppid = Number.parseInt(match[2]!, 10);
    const command = match[3]!;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    processes.push({ pid, ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : undefined, command });
  }
  return processes;
}

export function matchAgentBrowserChromeProcess(
  processInfo: HostProcessInfo,
  status: AgentBrowserToolStatus,
): AgentBrowserProcessMatch | undefined {
  if (processInfo.pid === process.pid) return undefined;
  if (!isChromeLikeCommand(processInfo.command)) return undefined;
  if (processInfo.command.includes(agentBrowserChromeLaunchMarker(status))) {
    return { process: processInfo, reason: 'launch-marker' };
  }
  if (managedBrowserHomeMarkers(status).some((marker) => processInfo.command.includes(marker))) {
    return { process: processInfo, reason: 'managed-browser-home' };
  }
  return undefined;
}

export function summarizeAgentBrowserProcesses(
  processes: HostProcessInfo[],
  status: AgentBrowserToolStatus,
): AgentBrowserProcessSummary {
  const matches = processes.flatMap((processInfo) => {
    const match = matchAgentBrowserChromeProcess(processInfo, status);
    return match ? [match] : [];
  });
  return {
    count: matches.length,
    pids: matches.map((match) => match.process.pid),
    processes: matches,
  };
}

export async function inspectManagedAgentBrowserProcesses(
  status: AgentBrowserToolStatus,
): Promise<AgentBrowserProcessSummary> {
  const processes = await listHostProcesses();
  return summarizeAgentBrowserProcesses(processes, status);
}

export async function cleanupManagedAgentBrowserOrphans(
  status: AgentBrowserToolStatus,
  reason: 'daemon-startup' | 'provider-startup',
): Promise<AgentBrowserProcessSummary> {
  const summary = await inspectManagedAgentBrowserProcesses(status);
  if (summary.count === 0) return summary;
  emitDiagnostic({
    level: 'warn',
    phase: 'web_agent_browser_orphan_cleanup',
    data: {
      reason,
      count: summary.count,
      pids: summary.pids,
      stateDir: status.stateDir,
      installDir: status.installDir,
      matchReasons: summary.processes.map((match) => match.reason),
    },
  });
  await stopMatchedProcesses(summary.processes);
  return summary;
}

async function listHostProcesses(): Promise<HostProcessInfo[]> {
  const result = await runCmd('ps', ['-ax', '-o', 'pid=,ppid=,command='], {
    allowFailure: true,
    timeoutMs: HOST_PROCESS_LIST_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) return [];
  return parseHostProcessList(result.stdout);
}

async function stopMatchedProcesses(matches: AgentBrowserProcessMatch[]): Promise<void> {
  const pids = uniquePids(matches.map((match) => match.process.pid));
  for (const pid of pids) {
    signalProcess(pid, 'SIGTERM');
  }
  await sleep(WEB_BROWSER_REAP_TERM_TIMEOUT_MS);
  for (const pid of pids) {
    if (!isProcessAlive(pid)) continue;
    signalProcess(pid, 'SIGKILL');
  }
  await Promise.all(
    pids.map(async (pid) => await waitForProcessExit(pid, WEB_BROWSER_REAP_KILL_TIMEOUT_MS)),
  );
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {}
}

function uniquePids(pids: number[]): number[] {
  return [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
}

function splitAgentBrowserArgs(args: string): string[] {
  return args
    .split(/[,\n]/)
    .map((arg) => arg.trim())
    .filter(Boolean);
}

function readPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isChromeLikeCommand(command: string): boolean {
  return /\b(?:Google Chrome for Testing|Chrome for Testing|Chromium|chrome|chrome\.exe|chromium|chromium-browser|headless_shell)\b/i.test(
    command,
  );
}

function managedBrowserHomeMarkers(status: AgentBrowserToolStatus): string[] {
  return uniqueStrings([
    path.join(status.homeDir, '.agent-browser', 'browsers'),
    path.join(status.runtimeHomeDir, '.agent-browser', 'browsers'),
    status.homeDir,
    status.runtimeHomeDir,
  ]);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
