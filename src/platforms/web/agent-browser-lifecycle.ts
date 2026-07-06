import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import {
  expandProcessTree,
  listHostProcesses,
  stopPidsWithEscalation,
  type HostProcessInfo,
} from '../../utils/host-process.ts';
import { withoutCommandExecutorOverride } from '../../utils/exec.ts';
import type { AgentBrowserToolStatus } from './agent-browser-tool.ts';

const HOST_PROCESS_LIST_TIMEOUT_MS = 1_500;
const WEB_BROWSER_REAP_TERM_TIMEOUT_MS = 1_500;
const WEB_BROWSER_REAP_KILL_TIMEOUT_MS = 1_000;
const PROVIDER_STARTUP_CLEANUP_DEBOUNCE_MS = 30_000;
const AGENT_DEVICE_BROWSER_MARKER_PREFIX = '--agent-device-managed-web=';
export const DEFAULT_AGENT_BROWSER_IDLE_TIMEOUT_MS = 5 * 60_000;

export type AgentBrowserProcessMatch = {
  process: HostProcessInfo;
  reason: 'launch-marker' | 'managed-browser-home';
};

export type AgentBrowserCleanupSkipReason = 'open-web-session' | 'recent-browser-activity';

export type AgentBrowserProcessSummary = {
  count: number;
  pids: number[];
  processes: AgentBrowserProcessMatch[];
};

export type AgentBrowserCleanupResult = AgentBrowserProcessSummary & {
  signalPids: number[];
  skipped?: {
    reason: AgentBrowserCleanupSkipReason;
    openWebSessionNames?: string[];
    idleTimeoutMs?: number;
    latestActivityMs?: number;
  };
};

export type AgentBrowserCleanupOptions = {
  openWebSessionNames?: readonly string[];
};

const providerStartupCleanupAttempts = new Map<string, number>();

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

export function matchAgentBrowserChromeProcess(
  processInfo: HostProcessInfo,
  status: AgentBrowserToolStatus,
): AgentBrowserProcessMatch | undefined {
  if (processInfo.pid === process.pid) return undefined;
  if (!isChromeLikeCommand(processInfo.command)) return undefined;
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
  const processes = await listRealHostProcesses();
  return summarizeAgentBrowserProcesses(processes, status);
}

export async function cleanupManagedAgentBrowserOrphans(
  status: AgentBrowserToolStatus,
  reason: 'daemon-startup' | 'provider-startup',
  options: AgentBrowserCleanupOptions = {},
): Promise<AgentBrowserCleanupResult> {
  const openWebSessionNames = uniqueStrings([...(options.openWebSessionNames ?? [])]);
  if (openWebSessionNames.length > 0) {
    return skippedCleanupResult('open-web-session', { openWebSessionNames });
  }

  const idleTimeoutMs = resolveAgentBrowserIdleTimeoutMs(process.env);
  const latestActivityMs = readLatestManagedBrowserActivityMs(status);
  if (latestActivityMs !== undefined && Date.now() - latestActivityMs < idleTimeoutMs) {
    return skippedCleanupResult('recent-browser-activity', { idleTimeoutMs, latestActivityMs });
  }

  const processes = await listRealHostProcesses();
  const summary = summarizeAgentBrowserProcesses(processes, status);
  const signalPids = expandProcessTree(
    summary.processes.map((match) => match.process.pid),
    processes,
  ).map((processInfo) => processInfo.pid);
  const result = { ...summary, signalPids };
  if (summary.count === 0) return result;
  emitDiagnostic({
    level: 'warn',
    phase: 'web_agent_browser_orphan_cleanup',
    data: {
      reason,
      count: summary.count,
      pids: summary.pids,
      signalPids,
      stateDir: status.stateDir,
      installDir: status.installDir,
      matchReasons: summary.processes.map((match) => match.reason),
    },
  });
  await stopPidsWithEscalation({
    pids: signalPids,
    termTimeoutMs: WEB_BROWSER_REAP_TERM_TIMEOUT_MS,
    killTimeoutMs: WEB_BROWSER_REAP_KILL_TIMEOUT_MS,
  });
  return result;
}

export async function cleanupManagedAgentBrowserOrphansForProviderStartup(
  status: AgentBrowserToolStatus,
  options: AgentBrowserCleanupOptions = {},
): Promise<AgentBrowserCleanupResult | undefined> {
  const now = Date.now();
  const key = path.resolve(status.stateDir);
  const lastAttemptMs = providerStartupCleanupAttempts.get(key);
  if (lastAttemptMs !== undefined && now - lastAttemptMs < PROVIDER_STARTUP_CLEANUP_DEBOUNCE_MS) {
    return undefined;
  }
  providerStartupCleanupAttempts.set(key, now);
  return await cleanupManagedAgentBrowserOrphans(status, 'provider-startup', options);
}

async function listRealHostProcesses(): Promise<HostProcessInfo[]> {
  return await withoutCommandExecutorOverride(
    async () => await listHostProcesses({ timeoutMs: HOST_PROCESS_LIST_TIMEOUT_MS }),
  );
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
  ]);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function skippedCleanupResult(
  reason: AgentBrowserCleanupSkipReason,
  details: Omit<NonNullable<AgentBrowserCleanupResult['skipped']>, 'reason'>,
): AgentBrowserCleanupResult {
  return {
    count: 0,
    pids: [],
    processes: [],
    signalPids: [],
    skipped: { reason, ...details },
  };
}

function isCommandUnderPath(processInfo: HostProcessInfo, rootPath: string): boolean {
  const command = normalizePathSeparators(processInfo.command);
  const root = `${normalizePathSeparators(path.resolve(rootPath)).replace(/\/+$/, '')}/`;
  return command.includes(root);
}

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

function readLatestManagedBrowserActivityMs(status: AgentBrowserToolStatus): number | undefined {
  const mtimes = readDirectoryEntries(status.socketDir)
    .map((entryPath) => readPathMtimeMs(entryPath))
    .filter((mtimeMs): mtimeMs is number => mtimeMs !== undefined);
  return mtimes.length > 0 ? Math.max(...mtimes) : undefined;
}

function readDirectoryEntries(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath).map((entry) => path.join(dirPath, entry));
  } catch {
    return [];
  }
}

function readPathMtimeMs(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}
